package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/samsaffron/term-llm/internal/credentials"
	"github.com/spf13/cobra"
)

// This machine-only helper executes in the original credential owner's home.
// Neither refresh tokens nor private paths are accepted as command arguments.
var authChatGPTSessionCmd = &cobra.Command{
	Use:          "chatgpt-session",
	Hidden:       true,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runAuthChatGPTSession,
}

func init() {
	authCmd.AddCommand(authChatGPTSessionCmd)
}

func runAuthChatGPTSession(cmd *cobra.Command, _ []string) error {
	rejected, err := readChatGPTSessionRequest(cmd.InOrStdin())
	if err != nil {
		return err
	}
	path, err := credentials.ChatGPTCredentialsPath()
	if err != nil {
		return fmt.Errorf("ChatGPT credential source is unavailable")
	}
	// Explicit-path lookup deliberately ignores any worker bridge setting,
	// avoiding recursion when a helper inherits a source's environment.
	creds, err := credentials.ChatGPTSessionAt(cmd.Context(), path, rejected)
	if err != nil {
		return err
	}
	session := credentials.ChatGPTSession{AccessToken: creds.AccessToken, ExpiresAt: creds.ExpiresAt, AccountID: creds.AccountID}
	if err := json.NewEncoder(cmd.OutOrStdout()).Encode(session); err != nil {
		return fmt.Errorf("could not write ChatGPT session")
	}
	return nil
}

func readChatGPTSessionRequest(r io.Reader) (string, error) {
	const limit = 32 << 10
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil || len(data) > limit {
		return "", fmt.Errorf("invalid ChatGPT session request")
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return "", fmt.Errorf("invalid ChatGPT session request")
	}
	var request struct {
		RejectedAccessToken string `json:"rejected_access_token,omitempty"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&request); err != nil || len(request.RejectedAccessToken) > 16<<10 {
		return "", fmt.Errorf("invalid ChatGPT session request")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return "", fmt.Errorf("invalid ChatGPT session request")
	}
	return request.RejectedAccessToken, nil
}
