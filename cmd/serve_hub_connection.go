package cmd

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/samsaffron/term-llm/internal/hub"
)

// testNodeConnection verifies API access as well as public health. Fleet health
// probes stay anonymous-compatible; an onboarding test must also check the token.
func (s *hubServer) testNodeConnection(ctx context.Context, n hub.Node) hub.Status {
	status := s.prober.Probe(ctx, n)
	if !status.Reachable {
		return status
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.BaseURL()+"/v1/capabilities", nil)
	if err != nil {
		status.Reachable, status.State, status.Error = false, "unreachable", "Could not prepare the assistant API access check."
		return status
	}
	if n.Token != "" {
		req.Header.Set("Authorization", "Bearer "+n.Token)
	}
	start := time.Now()
	// Use the same direct transport, timeout, and redirect policy as health probes.
	resp, err := s.prober.Client.Do(req)
	status.LatencyMS += time.Since(start).Milliseconds()
	if err != nil {
		status.Reachable, status.State, status.Error = false, "unreachable", "Could not verify assistant API access."
		return status
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		status.Reachable = false
		status.State = fmt.Sprintf("error %d", resp.StatusCode)
		status.Error = fmt.Sprintf("Assistant API returned HTTP %d.", resp.StatusCode)
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			status.Error += " Check the bearer token and authentication mode."
		}
	}
	return status
}
