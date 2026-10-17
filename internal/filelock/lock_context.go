package filelock

import (
	"context"
	"time"
)

// LockContext waits for an exclusive lock until ctx is cancelled. A cancelled
// waiter never retains a file descriptor or acquires the lock in the background.
func LockContext(ctx context.Context, path string) (func() error, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if ctx.Done() == nil {
		return Lock(path)
	}
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		unlock, err := TryLock(path)
		if !lockWouldBlock(err) {
			return unlock, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-tick.C:
		}
	}
}
