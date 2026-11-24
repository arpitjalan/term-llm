package mcpweb

import (
	"net/url"
	"strings"

	apphub "github.com/term-llm/term-llm/internal/app/serve/hub"
	"github.com/term-llm/term-llm/internal/hub"
)

const OAuthCallbackPath = "/v1/mcp/oauth/callback"

// HubCallbackReturnPath restores OAuth parameters on a validated login return path.
func HubCallbackReturnPath(basePath, safePath, raw string) string {
	id, nodePath, ok := apphub.ParseNodePath(strings.TrimPrefix(safePath, basePath))
	if !ok || nodePath != OAuthCallbackPath || hub.ValidateID(id) != nil {
		return safePath
	}

	// Cross-site callbacks can arrive without the Hub's strict session cookie.
	_, rawQuery, _ := strings.Cut(raw, "?")
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return safePath
	}
	callback := url.Values{}
	for _, key := range []string{"code", "state", "iss", "error"} {
		if values := query[key]; len(values) == 1 {
			callback.Set(key, values[0])
		}
	}
	if encoded := callback.Encode(); encoded != "" {
		return safePath + "?" + encoded
	}
	return safePath
}
