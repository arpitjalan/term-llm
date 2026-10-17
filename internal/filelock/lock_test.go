package filelock

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLockContextCancelsWhileLockIsHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resource.lock")
	unlock, err := Lock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, result := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		release, err := LockContext(ctx, path)
		if release != nil {
			_ = release()
		}
		result <- err
	}()
	<-started
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled lock: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled waiter retained the held lock request")
	}
}

func TestLockContextRejectsFilesystemErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := LockContext(ctx, filepath.Join(t.TempDir(), "missing", "resource.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing lock directory: %v", err)
	}
}

func TestTryLockDoesNotWaitForHeldLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resource.lock")
	unlock, err := TryLock(path)
	if err != nil {
		t.Fatalf("first TryLock: %v", err)
	}
	if _, err := TryLock(path); err == nil {
		t.Fatal("second TryLock unexpectedly acquired held lock")
	}
	if err := unlock(); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	unlockAgain, err := TryLock(path)
	if err != nil {
		t.Fatalf("TryLock after release: %v", err)
	}
	if err := unlockAgain(); err != nil {
		t.Fatalf("second unlock: %v", err)
	}
}

func TestLockReleaseAndReacquire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resource.lock")
	unlock, err := Lock(path)
	if err != nil {
		t.Fatalf("first Lock: %v", err)
	}
	if info, err := os.Stat(path); err != nil {
		t.Fatalf("stat lock file: %v", err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("lock file permissions = %o, want no group/other access", info.Mode().Perm())
	}
	if err := unlock(); err != nil {
		t.Fatalf("first unlock: %v", err)
	}
	unlockAgain, err := Lock(path)
	if err != nil {
		t.Fatalf("reacquire after release: %v", err)
	}
	if err := unlockAgain(); err != nil {
		t.Fatalf("second unlock: %v", err)
	}
	if err := unlock(); err == nil {
		t.Fatal("double unlock unexpectedly succeeded")
	}
}
