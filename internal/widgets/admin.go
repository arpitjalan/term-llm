package widgets

import (
	"errors"
	"io"
	"net/http"
	"strings"
)

// ServeAction handles POST <mount>/<action> beneath the admin widgets route:
// "stop" ends a widget's process until its next request, "disable" turns the
// widget off (stopping it), and "enable" turns it back on.
func (m *Manager) ServeAction(w http.ResponseWriter, r *http.Request, path string) {
	mount, action, _ := strings.Cut(path, "/")
	var run func() error
	switch action {
	case "stop":
		run = func() error { return m.StopMount(mount) }
	case "disable", "enable":
		run = func() error { return m.SetDisabled(mount, action == "disable") }
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := run(); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrNotFound) {
			status = http.StatusNotFound
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`)
}
