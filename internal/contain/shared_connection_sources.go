package contain

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/samsaffron/term-llm/internal/credentials"
)

type discoveredConnectionSource struct {
	view   ConnectionImportSource
	source sharedSource
}

func sourceID(source sharedSource) string {
	sum := sha256.Sum256([]byte(source.Kind + "\x00" + source.Path + "\x00" + source.Volume))
	return "source-" + hex.EncodeToString(sum[:16])
}

func (b *SharedConnections) ImportSources(ctx context.Context) ([]ConnectionImportSource, error) {
	sources, err := b.discoverSources(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]ConnectionImportSource, 0, len(sources))
	for _, source := range sources {
		views = append(views, source.view)
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Name < views[j].Name })
	return views, nil
}

func (b *SharedConnections) discoverSources(ctx context.Context) ([]discoveredConnectionSource, error) {
	path, err := credentials.ChatGPTCredentialsPath()
	if err != nil {
		return nil, sharedUnavailable("could not locate this server's saved sign-in")
	}
	server := sharedSource{Kind: "file", Path: path, Name: "This server"}
	sources := []discoveredConnectionSource{{view: ConnectionImportSource{ID: sourceID(server), Name: "This server", Kind: "server", Available: sourceFileAvailable(path)}, source: server}}
	if !sources[0].view.Available {
		sources[0].view.Message = "No saved ChatGPT sign-in on this server."
	}
	definitions, err := Definitions()
	if err != nil {
		return nil, sharedUnavailable("could not inspect existing assistant definitions")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	output, err := DockerPS(ctx, b.manager.opts.Runner, io.Discard)
	if err != nil {
		// A host sign-in remains usable even when Docker cannot enumerate old
		// assistants. Do not hide it or claim container sources are available.
		return sources, nil
	}
	containers := parseDockerPSLines(output)
	for _, def := range definitions {
		if usesSharedSeed(def.ConfigDir) {
			continue // Do not create a reference cycle through a broker worker.
		}
		source, ok := b.discoverVolumeSource(ctx, def, containers)
		if ok {
			sources = append(sources, source)
		}
	}
	return sources, nil
}

func usesSharedSeed(dir string) bool {
	data, err := readConnectionFile(filepath.Join(dir, "connection", "term-llm", connectionStateFile), 8192)
	if err != nil {
		return false
	}
	var state struct {
		ConnectionID string `json:"connection_id"`
	}
	return json.Unmarshal(data, &state) == nil && state.ConnectionID != ""
}

type connectionContainerInspection struct {
	Labels map[string]string `json:"labels"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Destination string `json:"Destination"`
	} `json:"mounts"`
}

var dockerVolumeNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

func (b *SharedConnections) discoverVolumeSource(ctx context.Context, def ListEntry, containers []dockerContainer) (discoveredConnectionSource, bool) {
	for _, container := range containers {
		if container.Labels["org.term-llm.contain.name"] != def.Name || container.Names == "" {
			continue
		}
		args := []string{"inspect", "--type", "container", "--format", `{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}`, container.Names}
		data, err := b.manager.opts.Runner.Output(ctx, "docker", args, RunOptions{Stderr: io.Discard})
		if err != nil || len(data) > 1<<20 {
			continue
		}
		var inspected connectionContainerInspection
		if json.Unmarshal(data, &inspected) != nil || inspected.Labels["org.term-llm.contain.name"] != def.Name || inspected.Labels["org.term-llm.contain.user"] != "agent" {
			continue
		}
		for _, mount := range inspected.Mounts {
			if mount.Type != "volume" || mount.Destination != "/home/agent" || !dockerVolumeNamePattern.MatchString(mount.Name) {
				continue
			}
			source := sharedSource{Kind: "volume", Volume: mount.Name, Name: def.Name}
			return discoveredConnectionSource{view: ConnectionImportSource{ID: sourceID(source), Name: def.Name, Kind: "assistant", Available: true, Message: "Uses the original assistant's saved sign-in; checked when imported."}, source: source}, true
		}
	}
	return discoveredConnectionSource{}, false
}

func sourceFileAvailable(path string) bool {
	data, err := readConnectionFile(path, 64<<10)
	if err != nil {
		return false
	}
	var creds credentials.ChatGPTCredentials
	return json.Unmarshal(data, &creds) == nil && creds.AccessToken != ""
}

func (b *SharedConnections) sourceAvailable(ctx context.Context, source sharedSource) bool {
	if source.Kind == "file" {
		return sourceFileAvailable(source.Path)
	}
	if source.Kind != "volume" || !dockerVolumeNamePattern.MatchString(source.Volume) {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := b.manager.opts.Runner.Output(ctx, "docker", []string{"volume", "inspect", "--format", "{{.Name}}", source.Volume}, RunOptions{Stderr: io.Discard})
	return err == nil
}

func (b *SharedConnections) Import(ctx context.Context, sourceIDValue, label string) (SharedConnection, error) {
	sources, err := b.discoverSources(ctx)
	if err != nil {
		return SharedConnection{}, err
	}
	for _, source := range sources {
		if source.view.ID != sourceIDValue {
			continue
		}
		if !source.view.Available {
			return SharedConnection{}, sharedUnavailable("the selected source does not have an available sign-in")
		}
		return b.importSource(ctx, source, label)
	}
	return SharedConnection{}, fmt.Errorf("%w: sign-in source not found; refresh the source list", ErrAssistantNotFound)
}

func (b *SharedConnections) importSource(ctx context.Context, source discoveredConnectionSource, label string) (SharedConnection, error) {
	name, err := sharedLabel(label, source.view.Name+" ChatGPT")
	if err != nil {
		return SharedConnection{}, err
	}
	// Verify the original authority can issue a usable session, without copying
	// its refresh token into broker metadata or any assistant's seed.
	if _, err := b.resolveSession(ctx, source.source, ""); err != nil {
		return SharedConnection{}, sharedUnavailable("the selected source's ChatGPT sign-in is unavailable; reconnect it at its original source")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return SharedConnection{}, sharedUnavailable("shared connections are shutting down")
	}
	for _, record := range b.state.Connections {
		if sourceID(record.Source) == sourceID(source.source) {
			view := record.Connection
			view.Available = true
			return view, nil
		}
	}
	id := uuid.NewString()
	record := sharedRecord{Connection: SharedConnection{ID: id, Name: name, Provider: "chatgpt", Source: source.view.Name, Available: true}, Source: source.source}
	b.state.Connections[id] = record
	if err := b.saveLocked(); err != nil {
		delete(b.state.Connections, id)
		return SharedConnection{}, err
	}
	return record.Connection, nil
}

func (b *SharedConnections) resolveSession(ctx context.Context, source sharedSource, rejected string) (*credentials.ChatGPTCredentials, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if coordinator := b.manager.opts.Coordinator; coordinator != nil {
		owned, release, err := coordinator.Root(ctx)
		if err != nil {
			return nil, sharedUnavailable("shared connections are reloading; retry shortly")
		}
		defer release()
		var stop func()
		ctx, stop = coordinator.Cancellable(owned)
		defer stop()
	}
	select {
	case b.slots <- struct{}{}:
		defer func() { <-b.slots }()
	case <-ctx.Done():
		return nil, sharedUnavailable("session request was cancelled while waiting for the broker")
	}
	if ctx.Err() != nil {
		return nil, sharedUnavailable("session request was cancelled")
	}
	if source.Kind == "file" {
		creds, err := b.session(source.Path, rejected)
		if err != nil || creds == nil || creds.AccessToken == "" || creds.AccountID == "" || creds.ExpiresAt <= time.Now().Unix() {
			return nil, sharedUnavailable("the original sign-in could not issue a usable session")
		}
		return creds, nil
	}
	if source.Kind != "volume" || !b.sourceAvailable(ctx, source) {
		return nil, sharedUnavailable("the original sign-in volume is unavailable")
	}
	return b.volumeSession(ctx, source, rejected)
}

func (b *SharedConnections) helperImage(ctx context.Context) (string, error) {
	if err := b.lockHelperImage(ctx); err != nil {
		return "", err
	}
	defer b.manager.buildMu.Unlock()
	binary, platform, err := b.manager.imageSource()
	if err != nil {
		return "", err
	}
	if b.manager.opts.Image != "" {
		return b.manager.opts.Image, nil
	}
	return b.manager.buildImage(ctx, binary, platform)
}

func (b *SharedConnections) lockHelperImage(ctx context.Context) error {
	if b.manager.buildMu.TryLock() {
		return nil
	}
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return sharedUnavailable("session request was cancelled while preparing its helper")
		case <-tick.C:
			if b.manager.buildMu.TryLock() {
				return nil
			}
		}
	}
}

func (b *SharedConnections) volumeSession(ctx context.Context, source sharedSource, rejected string) (*credentials.ChatGPTCredentials, error) {
	image, err := b.helperImage(ctx)
	if err != nil {
		return nil, sharedUnavailable("could not prepare the sign-in helper image")
	}
	helperName := "term-llm-connection-" + uuid.NewString()
	defer b.removeHelper(helperName)
	input, _ := json.Marshal(map[string]string{"rejected_access_token": rejected})
	args := []string{"run", "--rm", "--name", helperName, "--interactive", "--pull", "never", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--mount", "type=volume,source=" + source.Volume + ",target=/home/agent", "-e", "HOME=/home/agent", "-e", "XDG_CONFIG_HOME=/home/agent/.config", "--entrypoint", "/usr/local/bin/term-llm", image, "auth", "chatgpt-session"}
	output := &boundedConnectionOutput{remaining: 64 << 10}
	if err := b.manager.opts.Runner.Run(ctx, "docker", args, RunOptions{Stdin: bytes.NewReader(input), Stdout: output, Stderr: io.Discard}); err != nil {
		return nil, sharedUnavailable("the original assistant's saved sign-in could not issue a session")
	}
	if output.exceeded {
		return nil, sharedUnavailable("the sign-in helper returned an oversized response")
	}
	var session credentials.ChatGPTSession
	decoder := json.NewDecoder(bytes.NewReader(output.buffer.Bytes()))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&session) != nil || decoder.Decode(new(any)) != io.EOF || session.AccessToken == "" || session.AccountID == "" || session.ExpiresAt <= time.Now().Unix() {
		return nil, sharedUnavailable("the sign-in helper returned an invalid session")
	}
	return &credentials.ChatGPTCredentials{AccessToken: session.AccessToken, ExpiresAt: session.ExpiresAt, AccountID: session.AccountID}, nil
}

func (b *SharedConnections) removeHelper(name string) {
	// Cancelling the Docker client does not necessarily stop its container.
	// Clean up only our unique, short-lived helper, even after request timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = b.manager.opts.Runner.Run(ctx, "docker", []string{"rm", "--force", name}, RunOptions{Stdout: io.Discard, Stderr: io.Discard})
}

type boundedConnectionOutput struct {
	buffer    bytes.Buffer
	remaining int
	exceeded  bool
}

func (w *boundedConnectionOutput) Write(data []byte) (int, error) {
	if len(data) > w.remaining {
		w.exceeded = true
		return 0, fmt.Errorf("connection helper output exceeded limit")
	}
	w.remaining -= len(data)
	return w.buffer.Write(data)
}
