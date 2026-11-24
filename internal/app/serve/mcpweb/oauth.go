package mcpweb

import "net/url"

const OAuthCallbackPath = "/v1/mcp/oauth/callback"

// OAuthCallbackQuery keeps only unambiguous parameters read by the callback.
func OAuthCallbackQuery(raw string) string {
	query, err := url.ParseQuery(raw)
	if err != nil {
		return ""
	}
	callback := url.Values{}
	for _, key := range []string{"code", "state", "iss", "error"} {
		if values := query[key]; len(values) == 1 {
			callback.Set(key, values[0])
		}
	}
	return callback.Encode()
}
