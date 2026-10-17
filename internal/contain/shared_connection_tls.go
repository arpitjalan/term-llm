package contain

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/samsaffron/term-llm/internal/credentials"
)

func (b *SharedConnections) start() error {
	certificate, ca, err := b.certificate()
	if err != nil {
		return err
	}
	listener, err := listenConnectionBroker(b.manager.opts.ConnectionBrokerHost, b.state.Port)
	if err != nil {
		return sharedUnavailable("the saved shared-connection broker port is unavailable")
	}
	b.state.Port = listener.Addr().(*net.TCPAddr).Port
	b.ca = ca
	if err := b.saveLocked(); err != nil {
		listener.Close()
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	b.done = make(chan struct{})
	var handler http.Handler = http.HandlerFunc(b.serveSession)
	b.server = &http.Server{
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 60 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192,
		BaseContext: func(net.Listener) context.Context { return ctx },
		ErrorLog:    log.New(io.Discard, "", 0), // Do not echo peer input or credential-bearing errors.
	}
	if coordinator := b.manager.opts.Coordinator; coordinator != nil {
		handler = coordinator.Handler(handler)
		b.server.ConnState = coordinator.HTTPConnections()
	}
	b.server.Handler = handler
	secure := tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
	go func() {
		defer close(b.done)
		_ = b.server.Serve(secure)
	}()
	return nil
}

// ValidateConnectionBrokerHost accepts an explicit IPv4 interface address. An
// empty address preserves the default wildcard listener used by Docker Desktop.
func ValidateConnectionBrokerHost(host string) error {
	if host != "" {
		ip, err := netip.ParseAddr(host)
		if err != nil || !ip.Is4() {
			return fmt.Errorf("connection broker host must be an IPv4 address")
		}
	}
	return nil
}

func listenConnectionBroker(host string, port int) (net.Listener, error) {
	if err := ValidateConnectionBrokerHost(host); err != nil {
		return nil, err
	}
	if host == "" {
		host = "0.0.0.0"
	}
	return net.Listen("tcp4", net.JoinHostPort(host, strconv.Itoa(port)))
}

func (b *SharedConnections) certificate() (tls.Certificate, []byte, error) {
	ca, caErr := readConnectionFile(filepath.Join(b.root, "ca.pem"), 64<<10)
	cert, certErr := readConnectionFile(filepath.Join(b.root, "server.pem"), 64<<10)
	key, keyErr := readConnectionFile(filepath.Join(b.root, "server-key.pem"), 64<<10)
	if caErr == nil && certErr == nil && keyErr == nil {
		pair, err := tls.X509KeyPair(cert, key)
		if err != nil {
			return tls.Certificate{}, nil, sharedUnavailable("shared-connection TLS certificate is unreadable")
		}
		roots := x509.NewCertPool()
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil || !roots.AppendCertsFromPEM(ca) {
			return tls.Certificate{}, nil, sharedUnavailable("shared-connection TLS trust is unreadable")
		}
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "host.docker.internal"}); err != nil {
			return tls.Certificate{}, nil, sharedUnavailable("shared-connection TLS certificate is expired or invalid")
		}
		return pair, ca, nil
	}
	// Never replace a persisted trust root silently: running workers pin it.
	if b.state.Port != 0 || !os.IsNotExist(caErr) || !os.IsNotExist(certErr) || !os.IsNotExist(keyErr) {
		return tls.Certificate{}, nil, sharedUnavailable("shared-connection TLS files are missing or unreadable")
	}
	return b.createCertificate()
}

func (b *SharedConnections) createCertificate() (tls.Certificate, []byte, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, sharedUnavailable("could not create broker certificate")
	}
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, sharedUnavailable("could not create broker certificate")
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: randomCertificateSerial(), Subject: pkix.Name{CommonName: "Personal Bot connection authority"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, sharedUnavailable("could not create broker certificate")
	}
	server := &x509.Certificate{SerialNumber: randomCertificateSerial(), Subject: pkix.Name{CommonName: "Personal Bot connection broker"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(5, 0, 0), DNSNames: []string{"host.docker.internal", "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	serverDER, err := x509.CreateCertificate(rand.Reader, server, ca, &serverKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, sharedUnavailable("could not create broker certificate")
	}
	keyDER, err := x509.MarshalECPrivateKey(serverKey)
	if err != nil {
		return tls.Certificate{}, nil, sharedUnavailable("could not create broker certificate")
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := replaceConnectionFiles(b.root, []connectionSeedFile{{name: "ca.pem", data: caPEM}, {name: "server.pem", data: certPEM}, {name: "server-key.pem", data: keyPEM}}); err != nil {
		return tls.Certificate{}, nil, sharedUnavailable("could not save broker certificate")
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	return pair, caPEM, err
}

func randomCertificateSerial() *big.Int {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		// Key generation already uses crypto/rand and must have succeeded; this
		// fallback preserves a positive serial without exposing secret material.
		return big.NewInt(time.Now().UnixNano())
	}
	return serial.Add(serial, big.NewInt(1))
}

func (b *SharedConnections) authorize(token string) (sharedRecord, bool) {
	if len(token) != 64 {
		return sharedRecord{}, false
	}
	hash := hashBrokerToken(token)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return sharedRecord{}, false
	}
	for _, grant := range b.state.Grants {
		if grant.TokenHash == hash {
			record, ok := b.state.Connections[grant.ConnectionID]
			return record, ok
		}
	}
	return sharedRecord{}, false
}

func (b *SharedConnections) serveSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path != "/session" || r.Method != http.MethodPost {
		brokerError(w, http.StatusNotFound, "not found")
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	record, ok := b.authorize(token)
	if !ok || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		brokerError(w, http.StatusUnauthorized, "invalid assistant connection")
		return
	}
	request, err := credentials.ReadChatGPTSessionRequest(http.MaxBytesReader(w, r.Body, 32<<10))
	if err != nil {
		brokerError(w, http.StatusBadRequest, "invalid session request")
		return
	}
	session, err := b.resolveSession(r.Context(), record.Source, request.RejectedAccessToken)
	if err != nil {
		brokerError(w, http.StatusBadGateway, "shared sign-in is unavailable; reconnect its original source")
		return
	}
	// Only the short-lived session is serialized. Refresh ownership stays with
	// the original file or named volume, including on a forced 401 refresh.
	_ = json.NewEncoder(w).Encode(credentials.ChatGPTSession{AccessToken: session.AccessToken, ExpiresAt: session.ExpiresAt, AccountID: session.AccountID})
}

func brokerError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (b *SharedConnections) brokerURL() string {
	return fmt.Sprintf("https://127.0.0.1:%d", b.state.Port)
}
