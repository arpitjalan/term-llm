package credentials

import (
	"context"
	"errors"
	"fmt"
	"io"
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

// ChatGPTSessionRequest identifies an access token rejected by the provider.
// Empty requests ask for the source's current session without forcing refresh.
type ChatGPTSessionRequest struct {
	RejectedAccessToken string `json:"rejected_access_token,omitempty"`
}

// ReadChatGPTSessionRequest accepts one bounded request object for either the
// broker endpoint or the source helper, without returning credential contents
// in parsing errors.
func ReadChatGPTSessionRequest(r io.Reader) (ChatGPTSessionRequest, error) {
	var request ChatGPTSessionRequest
	if err := decodeChatGPTConnectionJSON(r, 32<<10, &request); err != nil || len(request.RejectedAccessToken) > 16<<10 {
		return ChatGPTSessionRequest{}, fmt.Errorf("invalid ChatGPT session request")
	}
	return request, nil
}

// ChatGPTSessionAt loads and refreshes the original credential file at an
// explicit absolute path. It ignores worker connection settings and never
// changes process environment. Its ordinary credential and refresh locks are
// the same locks used by existing local term-llm processes at that path.
// The returned value is for the authority only; serialize ChatGPTSession to
// workers so the refresh token remains at its source.
// Lock waits and refresh requests honor ctx; a completed token rotation is
// saved with a short cleanup deadline before returning caller cancellation.
func ChatGPTSessionAt(ctx context.Context, path, rejectedAccessToken string) (*ChatGPTCredentials, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(path) || len(rejectedAccessToken) > 16<<10 {
		return nil, fmt.Errorf("invalid ChatGPT session request")
	}
	creds, err := readChatGPTCredentials(path)
	if err == nil {
		err = refreshChatGPTCredentialsAt(ctx, path, creds, rejectedAccessToken, true)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if errors.Is(err, oauth.ErrChatGPTRefreshTokenInvalid) {
		return nil, fmt.Errorf("ChatGPT connection requires sign-in: %w", oauth.ErrChatGPTRefreshTokenInvalid)
	}
	if err != nil {
		return nil, fmt.Errorf("ChatGPT connection is unavailable; check its source and try again")
	}
	return creds, nil
}
