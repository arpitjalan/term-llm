package contain

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/oauth"
	"github.com/samsaffron/term-llm/internal/restart"
)

func TestConnectionDeviceFailuresAreSafeAndDoNotWrite(t *testing.T) {
	for _, tc := range []struct {
		name        string
		requestErr  error
		authErr     error
		credentials *oauth.ChatGPTCredentials
		saveErr     error
		want        string
	}{
		{name: "unsupported device", requestErr: oauth.ErrChatGPTDeviceCodeNotEnabled, want: "failed"},
		{name: "request failed", requestErr: errors.New("private-test-access-token"), want: "failed"},
		{name: "authentication failed", authErr: errors.New("private-test-refresh-token"), want: "failed"},
		{name: "expired", authErr: context.DeadlineExceeded, want: "expired"},
		{name: "incomplete", credentials: &oauth.ChatGPTCredentials{AccessToken: "private-test-access-token"}, want: "failed"},
		{name: "workspace started meanwhile", credentials: testChatGPTCredentials(), saveErr: ErrAssistantBusy, want: "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, workspace := testConnectionService(t)
			workspace.saveErr = tc.saveErr
			request := service.request
			service.request = func(ctx context.Context) (*oauth.ChatGPTDeviceCode, error) {
				if tc.requestErr != nil {
					return nil, tc.requestErr
				}
				return request(ctx)
			}
			service.authenticate = func(context.Context, *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error) {
				return tc.credentials, tc.authErr
			}
			if _, err := service.StartChatGPT(context.Background(), "assistant", ""); err != nil {
				t.Fatal(err)
			}
			service.wg.Wait()
			status := connectionStatus(t, service, tc.want)
			if status.State != "needs_connection" || workspace.saves != 0 || status.Flow.UserCode != "" {
				t.Fatalf("failed sign-in changed connection: %+v", status)
			}
		})
	}
}

func TestConnectionDeviceRequiresStoppedManagedWorkspaceBeforeNetwork(t *testing.T) {
	service, workspace := testConnectionService(t)
	workspace.checkErr = ErrAssistantBusy
	service.request = func(context.Context) (*oauth.ChatGPTDeviceCode, error) {
		t.Fatal("OAuth network called before workspace validation")
		return nil, nil
	}
	if _, err := service.StartChatGPT(context.Background(), "assistant", ""); !errors.Is(err, ErrAssistantBusy) {
		t.Fatalf("running workspace: %v", err)
	}
	if _, err := service.StartChatGPT(context.Background(), "unmanaged", ""); !errors.Is(err, ErrAssistantNotFound) {
		t.Fatalf("unmanaged workspace: %v", err)
	}
}

func TestConnectionDeviceRepeatedStartReusesPendingFlowAndCloseCancels(t *testing.T) {
	service, workspace := testConnectionService(t)
	started := make(chan context.Context, 1)
	requests := 0
	request := service.request
	service.request = func(ctx context.Context) (*oauth.ChatGPTDeviceCode, error) {
		requests++
		return request(ctx)
	}
	service.authenticate = func(ctx context.Context, _ *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error) {
		started <- ctx
		<-ctx.Done()
		return nil, ctx.Err()
	}
	first := mustStartConnection(t, service)
	ctx := awaitConnectionContext(t, started)
	second := mustStartConnection(t, service)
	if first.Flow.ID != second.Flow.ID || requests != 1 {
		t.Fatal("repeated start created duplicate device operation")
	}
	service.Close()
	if ctx.Err() == nil || workspace.saves != 0 {
		t.Fatal("close failed to cancel without writing credentials")
	}
}

func TestConnectionDeviceFlowStorageIsBoundedAndPruned(t *testing.T) {
	service, _ := testConnectionService(t)
	now := time.Now()
	service.now = func() time.Time { return now }
	for i := 0; i < 64; i++ {
		if _, _, _, err := service.beginDevice(fmt.Sprint(i), "model"); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, _, err := service.beginDevice("overflow", "model"); !errors.Is(err, ErrAssistantUnavailable) {
		t.Fatalf("unbounded flow admission: %v", err)
	}
	now = now.Add(deviceConnectionLifetime)
	service.mu.Lock()
	service.pruneLocked()
	service.mu.Unlock()
	for _, flow := range service.flows {
		if flow.view.State != "expired" {
			t.Fatal("past-deadline flow did not expire")
		}
	}
	now = now.Add(5 * time.Minute)
	if _, _, _, err := service.beginDevice("fresh", "model"); err != nil {
		t.Fatal(err)
	}
	if len(service.flows) != 1 {
		t.Fatal("terminal flow records were not pruned")
	}
}

func TestConnectionDeviceCancelInterruptsInitialCodeRequest(t *testing.T) {
	service, _ := testConnectionService(t)
	started := make(chan context.Context, 1)
	service.request = func(ctx context.Context) (*oauth.ChatGPTDeviceCode, error) {
		started <- ctx
		<-ctx.Done()
		return nil, ctx.Err()
	}
	finished := make(chan error, 1)
	go func() {
		_, err := service.StartChatGPT(context.Background(), "assistant", "")
		finished <- err
	}()
	ctx := awaitConnectionContext(t, started)
	status := connectionStatus(t, service, "pending")
	if _, err := service.Cancel("assistant", status.Flow.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, ErrAssistantBusy) || ctx.Err() == nil {
			t.Fatalf("initial request was not cancelled: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("initial code request was not interrupted")
	}
}

func TestConnectionDeviceReloadWaitsForSafeCompletion(t *testing.T) {
	service, workspace := testConnectionService(t)
	coordinator := &restart.Coordinator{InterruptAfter: time.Nanosecond}
	service.coordinator = coordinator
	started := make(chan context.Context, 1)
	service.authenticate = func(ctx context.Context, _ *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error) {
		started <- ctx
		<-ctx.Done()
		return nil, ctx.Err()
	}
	mustStartConnection(t, service)
	awaitConnectionContext(t, started)
	settled := make(chan ConnectionStatus, 1)
	unbind, err := coordinator.Bind(context.Background(), func(context.Context) error {
		status, _ := service.Status("assistant")
		settled <- status
		return errors.New("test replacement was not executed")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unbind()
	coordinator.Request()
	select {
	case status := <-settled:
		if status.Flow == nil || status.Flow.State != "failed" || workspace.saves != 0 {
			t.Fatal("reload reached replacement before sign-in safely stopped")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reload failed to cancel pending sign-in")
	}
}
