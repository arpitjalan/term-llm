package cmd

import (
	"encoding/json"
	"fmt"

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
	request, err := credentials.ReadChatGPTSessionRequest(cmd.InOrStdin())
	if err != nil {
		return err
	}
	path, err := credentials.ChatGPTCredentialsPath()
	if err != nil {
		return fmt.Errorf("ChatGPT credential source is unavailable")
	}
	// Explicit-path lookup deliberately ignores any worker bridge setting,
	// avoiding recursion when a helper inherits a source's environment.
	creds, err := credentials.ChatGPTSessionAt(cmd.Context(), path, request.RejectedAccessToken)
	if err != nil {
		return err
	}
	session := credentials.ChatGPTSession{AccessToken: creds.AccessToken, ExpiresAt: creds.ExpiresAt, AccountID: creds.AccountID}
	if err := json.NewEncoder(cmd.OutOrStdout()).Encode(session); err != nil {
		return fmt.Errorf("could not write ChatGPT session")
	}
	return nil
}
