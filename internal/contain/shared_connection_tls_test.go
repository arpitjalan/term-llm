package contain

import (
	"net"
	"testing"
)

func TestConnectionBrokerListenerBindsSelectedIPv4Interface(t *testing.T) {
	for _, tc := range []struct{ name, host, want string }{
		{"default wildcard", "", "0.0.0.0"},
		{"explicit wildcard", "0.0.0.0", "0.0.0.0"},
		{"loopback only", "127.0.0.1", "127.0.0.1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := listenConnectionBroker(tc.host, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			address := listener.Addr().(*net.TCPAddr)
			if address.IP.String() != tc.want || address.Port == 0 {
				t.Fatalf("broker bound to %s, want %s with an assigned port", address, tc.want)
			}
		})
	}
}

func TestConnectionBrokerHostRequiresIPv4(t *testing.T) {
	for _, host := range []string{"", "0.0.0.0", "127.0.0.1", "172.17.0.1"} {
		if err := ValidateConnectionBrokerHost(host); err != nil {
			t.Errorf("rejected IPv4 host %q: %v", host, err)
		}
	}
	for _, host := range []string{"localhost", "::1", "::ffff:127.0.0.1", "172.17.0.1:443", "127.0.0.999", " 127.0.0.1", "\n"} {
		t.Run(host, func(t *testing.T) {
			if _, err := NewManager(ManagerOptions{ConnectionBrokerHost: host}); err == nil {
				t.Fatal("manager accepted a non-IPv4 broker address")
			}
			if listener, err := listenConnectionBroker(host, 0); err == nil {
				listener.Close()
				t.Fatal("listener accepted a non-IPv4 broker address")
			}
		})
	}
}
