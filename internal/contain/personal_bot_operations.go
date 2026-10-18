package contain

import (
	"context"
	"fmt"
	"io"
	"sort"
	"time"
)

const (
	assistantOperationTimeout = 10 * time.Minute
	assistantStartTimeout     = 30 * time.Minute
)

func (m *Manager) Start(name string) (Operation, error)   { return m.begin(name, "start") }
func (m *Manager) Stop(name string) (Operation, error)    { return m.begin(name, "stop") }
func (m *Manager) Restart(name string) (Operation, error) { return m.begin(name, "restart") }

func (m *Manager) begin(name, action string) (Operation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.canBegin(name); err != nil {
		return Operation{}, err
	}
	record, err := m.readRecord(name)
	if err != nil {
		return Operation{}, err
	}
	if action != "stop" && record.Assistant.NeedsConnection {
		return Operation{}, fmt.Errorf("%w: connect a model provider before starting this assistant", ErrAssistantInvalid)
	}
	ctx, release, err := m.operationContext(action)
	if err != nil {
		return Operation{}, err
	}
	op := newAssistantOperation(name, action)
	record.Operation = op
	record.Assistant.OperationID = op.ID
	record.Assistant.Error = ""
	if err := m.writeRecord(record); err != nil {
		release()
		return Operation{}, err
	}
	m.operations[op.ID] = op
	m.busy[name] = true
	m.wg.Add(1)
	go func() {
		defer release()
		m.run(ctx, record)
	}()
	return op, nil
}

func (m *Manager) operationContext(action string) (context.Context, func(), error) {
	ctx, cancel := context.WithTimeout(m.ctx, operationTimeout(action))
	if m.opts.Coordinator == nil {
		return ctx, cancel, nil
	}
	ctx, release, err := m.opts.Coordinator.Root(ctx)
	if err != nil {
		cancel()
		return nil, nil, fmt.Errorf("%w: server is reloading; retry shortly", ErrAssistantUnavailable)
	}
	ctx, stop := m.opts.Coordinator.Cancellable(ctx)
	return ctx, func() { stop(); release(); cancel() }, nil
}

func operationTimeout(action string) time.Duration {
	if action == "start" {
		// A first start prepares the runtime image and may need to download every
		// base layer before Compose can create the assistant container.
		return assistantStartTimeout
	}
	return assistantOperationTimeout
}

func (m *Manager) run(ctx context.Context, record assistantRecord) {
	defer m.wg.Done()
	err := m.runAction(ctx, record)
	if ctx.Err() != nil {
		if ctx.Err() == context.DeadlineExceeded {
			err = fmt.Errorf("operation exceeded its %d minute time limit; check assistant status before retrying", operationTimeout(record.Operation.Action)/time.Minute)
		} else {
			err = fmt.Errorf("operation was interrupted; check assistant status before retrying")
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.finish(record, err)
}

func (m *Manager) runAction(ctx context.Context, record assistantRecord) error {
	name := record.Assistant.Name
	switch record.Operation.Action {
	case "start":
		if err := m.prepareImage(ctx, name); err != nil {
			return err
		}
		m.setOperationStage(record.Operation.ID, "starting_container")
		if err := Start(ctx, m.opts.Runner, name, io.Discard, io.Discard); err != nil {
			return fmt.Errorf("could not start assistant; check Docker availability, disk space and the assigned port")
		}
	case "stop":
		if err := Stop(ctx, m.opts.Runner, name, io.Discard, io.Discard); err != nil {
			return fmt.Errorf("could not stop assistant; check Docker availability")
		}
	case "restart":
		if err := Restart(ctx, m.opts.Runner, name, io.Discard, io.Discard); err != nil {
			return fmt.Errorf("could not restart assistant; check Docker availability")
		}
	}
	return nil
}

func (m *Manager) setOperationStage(id, stage string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	op, ok := m.operations[id]
	if !ok || op.State != "running" {
		return
	}
	op.Stage = stage
	m.operations[id] = op
}

func (m *Manager) create(ctx context.Context, req CreateAssistantRequest, op Operation) {
	defer m.wg.Done()
	// Keep port selection and reservation atomic across creations in this manager.
	m.mu.Lock()
	defer m.mu.Unlock()
	record := assistantRecord{Version: 1, Operation: op, Assistant: ManagedAssistant{
		Name: req.Name, Purpose: req.Purpose, State: "needs_connection", NeedsConnection: true,
		NodeID: req.Name, CreatedAt: op.StartedAt, OperationID: op.ID,
	}}
	err := m.createFiles(ctx, record)
	m.finish(record, err)
}

func (m *Manager) finish(record assistantRecord, err error) {
	now := time.Now().UTC()
	op := record.Operation
	if current, ok := m.operations[op.ID]; ok {
		op.Stage = current.Stage
	}
	op.State = "succeeded"
	op.FinishedAt = &now
	if err != nil {
		op.State = "failed"
		op.Error = err.Error()
	}
	record.Operation = op
	record.Assistant.Error = op.Error
	if op.State == "succeeded" && op.Action != "create" {
		record.Assistant.State = "running"
		if op.Action == "stop" {
			record.Assistant.State = "stopped"
		}
	}
	// Persist only an operation whose owned metadata was successfully reserved.
	// A competing CLI creation must never be adopted after our creation fails.
	if m.latest[op.Name] == op.ID {
		if writeErr := m.writeRecord(record); writeErr != nil {
			op.State = "failed"
			op.Error = "could not save assistant status; refresh before trying again"
		}
	}
	m.operations[op.ID] = op
	m.pruneOperations()
	delete(m.busy, op.Name)
}

func (m *Manager) pruneOperations() {
	// Preserve every assistant's latest operation and all running operations.
	// Keep a bounded history so a client can finish polling an older action.
	var history []Operation
	for _, op := range m.operations {
		if op.State != "running" && m.latest[op.Name] != op.ID {
			history = append(history, op)
		}
	}
	sort.Slice(history, func(i, j int) bool { return history[i].StartedAt.After(history[j].StartedAt) })
	for i := 256; i < len(history); i++ {
		delete(m.operations, history[i].ID)
	}
}

func (m *Manager) recoverOperations() error {
	records, err := m.records()
	if err != nil {
		return err
	}
	for _, record := range records {
		m.latest[record.Assistant.Name] = record.Operation.ID
		if record.Operation.State == "running" {
			now := time.Now().UTC()
			record.Operation.State = "failed"
			record.Operation.Error = "server restarted during this operation; check assistant status before retrying"
			record.Operation.FinishedAt = &now
			record.Assistant.Error = record.Operation.Error
			if err := m.writeRecord(record); err != nil {
				return err
			}
		}
		if record.Operation.ID != "" {
			m.operations[record.Operation.ID] = record.Operation
		}
	}
	return nil
}
