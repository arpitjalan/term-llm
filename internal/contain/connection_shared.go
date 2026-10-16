package contain

import (
	"context"
	"fmt"

	"github.com/samsaffron/term-llm/internal/oauth"
)

func (s *ConnectionService) SharedConnections(ctx context.Context) ([]SharedConnection, error) {
	if s.shared == nil {
		return nil, fmt.Errorf("%w: reusable connections are unavailable", ErrAssistantUnavailable)
	}
	return s.shared.List(ctx)
}

func (s *ConnectionService) ImportSources(ctx context.Context) ([]ConnectionImportSource, error) {
	if s.shared == nil {
		return nil, fmt.Errorf("%w: reusable connections are unavailable", ErrAssistantUnavailable)
	}
	return s.shared.ImportSources(ctx)
}

func (s *ConnectionService) ImportConnection(ctx context.Context, sourceID, name string) (SharedConnection, error) {
	if s.shared == nil {
		return SharedConnection{}, fmt.Errorf("%w: reusable connections are unavailable", ErrAssistantUnavailable)
	}
	return s.shared.Import(ctx, sourceID, name)
}

func (s *ConnectionService) UseSharedConnection(name, id, model string) (ConnectionStatus, error) {
	model, err := connectionModel("chatgpt", model)
	if err != nil {
		return ConnectionStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.shared == nil {
		return ConnectionStatus{}, fmt.Errorf("%w: reusable connections are unavailable", ErrAssistantUnavailable)
	}
	var bridge BridgeConnection
	_, err = s.workspaces.WithConnection(name, func(dir string) error {
		var saveErr error
		bridge, saveErr = s.attachSharedLocked(dir, name, id, model)
		return saveErr
	})
	if err != nil {
		return ConnectionStatus{}, s.rollbackSharedLocked(bridge, err)
	}
	s.cancelLocked(name, "cancelled", "Replaced by an existing connection.")
	return s.statusLocked(name)
}

func (s *ConnectionService) attachSharedLocked(dir, name, id, model string) (BridgeConnection, error) {
	bridge, err := s.shared.Attach(name, id)
	if err != nil {
		return BridgeConnection{}, err
	}
	status := ConnectionStatus{
		State: "authorized", Provider: "chatgpt", Model: model,
		ConnectionID: bridge.ConnectionID, ConnectionName: bridge.ConnectionName,
		Message: "Connected using " + bridge.ConnectionName + ". The Hub keeps this connection available to your assistants.",
	}
	return bridge, writeConnectionSeed(dir, status, "", nil, bridge.Data)
}

func (s *ConnectionService) rollbackSharedLocked(bridge BridgeConnection, err error) error {
	if bridge.ConnectionID != "" {
		if restoreErr := s.shared.RollbackAttachment(bridge); restoreErr != nil {
			return fmt.Errorf("%w: connection assignment could not be restored; choose a connection again before starting", ErrAssistantUnavailable)
		}
	}
	return err
}

func (s *ConnectionService) persistChatGPTLocked(name string, status ConnectionStatus, creds *oauth.ChatGPTCredentials) error {
	// The isolated service seam remains useful for device-flow tests. Production
	// always enables the shared store and never seeds a copied refresh token.
	if s.shared == nil {
		return s.persistLocked(name, status, "", creds)
	}
	var bridge BridgeConnection
	_, err := s.workspaces.WithConnection(name, func(dir string) error {
		connection, err := s.shared.CreateChatGPT(creds, "ChatGPT · "+name)
		if err != nil {
			return err
		}
		bridge, err = s.attachSharedLocked(dir, name, connection.ID, status.Model)
		return err
	})
	if err != nil {
		return s.rollbackSharedLocked(bridge, err)
	}
	return err
}
