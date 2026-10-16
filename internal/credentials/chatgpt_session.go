package credentials

import (
	"errors"
	"fmt"
	"path/filepath"

	"github.com/samsaffron/term-llm/internal/oauth"
)

// ChatGPTSession is the access-only wire format for shared connections. A
// refresh token must never cross the source authority's boundary.
type ChatGPTSession struct {
	AccessToken string `json:"access_token"`
	ExpiresAt   int64  `json:"expires_at"`
	AccountID   string `json:"account_id"`
}

// ChatGPTSessionAt loads and refreshes the original credential file at an
// explicit absolute path. It ignores worker connection settings and never
// changes process environment. Its ordinary credential and refresh locks are
// the same locks used by existing local term-llm processes at that path.
// The returned value is for the authority only; serialize ChatGPTSession to
// workers so the refresh token remains at its source.
func ChatGPTSessionAt(path, rejectedAccessToken string) (*ChatGPTCredentials, error) {
	if !filepath.IsAbs(path) || len(rejectedAccessToken) > 16<<10 {
		return nil, fmt.Errorf("invalid ChatGPT session request")
	}
	creds, err := readChatGPTCredentials(path)
	if err == nil {
		err = refreshChatGPTCredentialsAt(path, creds, rejectedAccessToken, true)
	}
	if errors.Is(err, oauth.ErrChatGPTRefreshTokenInvalid) {
		return nil, fmt.Errorf("ChatGPT connection requires sign-in: %w", oauth.ErrChatGPTRefreshTokenInvalid)
	}
	if err != nil {
		return nil, fmt.Errorf("ChatGPT connection is unavailable; check its source and try again")
	}
	return creds, nil
}
