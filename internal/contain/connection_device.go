package contain

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/samsaffron/term-llm/internal/oauth"
)

const deviceConnectionLifetime = 15 * time.Minute

func (s *ConnectionService) StartChatGPT(ctx context.Context, name, model string) (ConnectionStatus, error) {
	model, err := connectionModel("chatgpt", model)
	if err != nil {
		return ConnectionStatus{}, err
	}
	if err := s.workspaces.CheckConnection(name); err != nil {
		return ConnectionStatus{}, err
	}
	flow, flowCtx, existing, err := s.beginDevice(name, model)
	if err != nil || existing {
		if err != nil {
			return ConnectionStatus{}, err
		}
		return s.Status(name)
	}
	workerStarted := false
	defer func() {
		if !workerStarted {
			flow.release()
		}
	}()
	// Only the initial code request belongs to this HTTP request. Once the code
	// is issued, polling belongs to the bounded service flow, not its client.
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	stopCancel := context.AfterFunc(flowCtx, cancel)
	code, requestErr := s.request(requestCtx)
	stopCancel()
	cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flows[name] != flow || flow.view.State != "pending" || s.closed {
		flow.cancel()
		return ConnectionStatus{}, fmt.Errorf("%w: sign-in was cancelled or replaced", ErrAssistantBusy)
	}
	if requestErr != nil || code == nil || code.UserCode == "" || code.VerificationURL != oauth.ChatGPTDeviceVerificationURL {
		message := "Could not start ChatGPT sign-in. Try again or connect with an API key."
		if errors.Is(requestErr, oauth.ErrChatGPTDeviceCodeNotEnabled) {
			message = "ChatGPT device sign-in is unavailable. Connect with an API key or try again later."
		}
		s.finishLocked(flow, "failed", message)
		return s.statusLocked(name)
	}
	flow.view.UserCode = code.UserCode
	flow.view.VerificationURL = code.VerificationURL
	flow.view.Message = "Open the verification page and enter this code."
	s.wg.Add(1)
	workerStarted = true
	go s.completeDevice(flowCtx, name, flow, code)
	return s.statusLocked(name)
}

func (s *ConnectionService) beginDevice(name, model string) (*deviceConnection, context.Context, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	if s.closed {
		return nil, nil, false, fmt.Errorf("%w: provider setup is shutting down", ErrAssistantUnavailable)
	}
	if flow := s.flows[name]; flow != nil && flow.view.State == "pending" {
		return flow, nil, true, nil
	}
	if len(s.flows) >= 64 {
		return nil, nil, false, fmt.Errorf("%w: too many sign-in attempts; try again shortly", ErrAssistantUnavailable)
	}
	id := connectionFlowID()
	if id == "" {
		return nil, nil, false, fmt.Errorf("%w: could not start sign-in", ErrAssistantUnavailable)
	}
	ctx, cancel, release, err := s.deviceContext()
	if err != nil {
		return nil, nil, false, err
	}
	flow := &deviceConnection{model: model, cancel: cancel, release: release, view: ConnectionFlow{
		ID: id, State: "pending", ExpiresAt: s.now().Add(deviceConnectionLifetime), Message: "Preparing ChatGPT sign-in…",
	}}
	s.flows[name] = flow
	return flow, ctx, false, nil
}

// Detached sign-in retains reload ownership through its final credential commit.
// Reload's normal grace cancellation interrupts polling without waiting 15 minutes.
func (s *ConnectionService) deviceContext() (context.Context, context.CancelFunc, func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), deviceConnectionLifetime)
	if s.coordinator == nil {
		return ctx, cancel, cancel, nil
	}
	owned, release, err := s.coordinator.Root(ctx)
	if err != nil {
		cancel()
		return nil, nil, nil, fmt.Errorf("%w: server is reloading; retry sign-in shortly", ErrAssistantUnavailable)
	}
	owned, stop := s.coordinator.Cancellable(owned)
	return owned, cancel, func() { stop(); release(); cancel() }, nil
}

func (s *ConnectionService) completeDevice(ctx context.Context, name string, flow *deviceConnection, code *oauth.ChatGPTDeviceCode) {
	defer s.wg.Done()
	defer flow.release()
	creds, err := s.authenticate(ctx, code)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flows[name] != flow || flow.view.State != "pending" || s.closed {
		return
	}
	if err != nil || ctx.Err() != nil {
		state, message := "failed", "ChatGPT sign-in did not finish. Try again; no credentials were changed."
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			state, message = "expired", "This sign-in code expired. Start sign-in again for a new code."
		}
		s.finishLocked(flow, state, message)
		return
	}
	if creds == nil || creds.AccessToken == "" || creds.RefreshToken == "" || creds.ExpiresAt <= s.now().Unix() {
		s.finishLocked(flow, "failed", "ChatGPT returned incomplete credentials. Start sign-in again.")
		return
	}
	status := ConnectionStatus{State: "authorized", Provider: "chatgpt", Model: flow.model,
		Message: "ChatGPT sign-in is complete. Start the assistant and send a message to check model access."}
	if err := s.persistChatGPTLocked(name, status, creds); err != nil {
		s.finishLocked(flow, "failed", "Could not save this connection. Keep the assistant stopped and try signing in again.")
		return
	}
	s.finishLocked(flow, "succeeded", "ChatGPT sign-in complete.")
}

func (s *ConnectionService) Cancel(name, flowID string) (ConnectionStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.workspaces.ConnectionDir(name); err != nil {
		return ConnectionStatus{}, err
	}
	flow := s.flows[name]
	if flow == nil || flowID == "" || flow.view.ID != flowID {
		return ConnectionStatus{}, fmt.Errorf("%w: sign-in changed; refresh its status before cancelling", ErrAssistantBusy)
	}
	if flow.view.State == "pending" {
		s.finishLocked(flow, "cancelled", "Sign-in cancelled. No credentials were changed.")
	}
	return s.statusLocked(name)
}

func (s *ConnectionService) cancelLocked(name, state, message string) {
	if flow := s.flows[name]; flow != nil && flow.view.State == "pending" {
		s.finishLocked(flow, state, message)
	}
}

func (s *ConnectionService) finishLocked(flow *deviceConnection, state, message string) {
	flow.cancel()
	flow.view.State, flow.view.Message = state, message
	flow.view.UserCode, flow.view.VerificationURL = "", ""
	flow.finishedAt = s.now()
}

func (s *ConnectionService) pruneLocked() {
	for name, flow := range s.flows {
		if flow.view.State == "pending" && !s.now().Before(flow.view.ExpiresAt) {
			s.finishLocked(flow, "expired", "This sign-in code expired. Start sign-in again for a new code.")
		}
		if !flow.finishedAt.IsZero() && s.now().Sub(flow.finishedAt) >= 5*time.Minute {
			delete(s.flows, name)
		}
	}
}
