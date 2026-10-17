package credentials

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const chatGPTConnectionEnv = "TERM_LLM_CHATGPT_CONNECTION_FILE"

type chatGPTConnectionConfig struct {
	URL    string `json:"url"`
	Token  string `json:"token"`
	CACert string `json:"ca_cert"`
}

// ChatGPTConnectionConfigured reports whether this worker uses a shared
// connection. A broken connection must not fall back to local credentials.
func ChatGPTConnectionConfigured() bool {
	return os.Getenv(chatGPTConnectionEnv) != ""
}

func readChatGPTConnectionConfig() (*chatGPTConnectionConfig, error) {
	path := os.Getenv(chatGPTConnectionEnv)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("ChatGPT connection configuration must be a private regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("ChatGPT connection configuration is unavailable")
	}
	defer f.Close()
	var cfg chatGPTConnectionConfig
	if err := decodeChatGPTConnectionJSON(f, 32<<10, &cfg); err != nil {
		return nil, fmt.Errorf("ChatGPT connection configuration is invalid")
	}
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return nil, fmt.Errorf("ChatGPT connection requires an HTTPS server address")
	}
	if !validChatGPTConnectionToken(cfg.Token, 4096) || cfg.CACert == "" {
		return nil, fmt.Errorf("ChatGPT connection configuration is incomplete")
	}
	return &cfg, nil
}

func loadChatGPTConnectionSession(rejectedAccessToken string) (*ChatGPTCredentials, error) {
	if len(rejectedAccessToken) > 16<<10 {
		return nil, fmt.Errorf("ChatGPT session request is invalid")
	}
	cfg, err := readChatGPTConnectionConfig()
	if err != nil {
		return nil, err
	}
	client, err := newChatGPTConnectionClient(cfg.CACert)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	body, _ := json.Marshal(ChatGPTSessionRequest{RejectedAccessToken: rejectedAccessToken})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(cfg.URL, "/")+"/session", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("ChatGPT connection request is invalid")
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		// Transport errors may include the private address or bearer material.
		return nil, fmt.Errorf("ChatGPT connection is unavailable; check the server and try again")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ChatGPT connection could not provide a session; check its sign-in in Personal Bot setup")
	}
	var session ChatGPTSession
	if err := decodeChatGPTConnectionJSON(resp.Body, 64<<10, &session); err != nil {
		return nil, fmt.Errorf("ChatGPT connection returned an invalid session")
	}
	if !validChatGPTConnectionToken(session.AccessToken, 16<<10) || session.ExpiresAt <= time.Now().Unix() || len(session.AccountID) > 1024 {
		return nil, fmt.Errorf("ChatGPT connection returned an invalid session")
	}
	return &ChatGPTCredentials{AccessToken: session.AccessToken, ExpiresAt: session.ExpiresAt, AccountID: session.AccountID}, nil
}

func newChatGPTConnectionClient(caCert string) (*http.Client, error) {
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(caCert)) {
		return nil, fmt.Errorf("ChatGPT connection certificate is invalid")
	}
	return &http.Client{
		Timeout: 45 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			// Deliberately ignore system proxies and roots: credentials go only
			// to the configured authority authenticated by the supplied CA.
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			TLSClientConfig:       &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 35 * time.Second,
			DisableKeepAlives:     true,
		},
	}, nil
}

func validChatGPTConnectionToken(token string, max int) bool {
	if token == "" || len(token) > max {
		return false
	}
	for _, c := range token {
		if c <= ' ' || c >= 127 {
			return false
		}
	}
	return true
}

func decodeChatGPTConnectionJSON(r io.Reader, limit int64, dst any) error {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil || int64(len(data)) > limit {
		return fmt.Errorf("invalid JSON size")
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return fmt.Errorf("expected JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON object")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("unexpected trailing JSON")
	}
	return nil
}
