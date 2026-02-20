// Tests for the event bus

import { describe, it, expect, vi } from 'vitest';
import { bus, Events } from '../sidepanel/utils/event-bus.js';

describe('EventBus', () => {
  it('emits events to subscribers', () => {
    const handler = vi.fn();
    bus.on('test:event', handler);
    bus.emit('test:event', { foo: 'bar' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ foo: 'bar' });

    bus.off('test:event', handler);
  });

  it('supports multiple subscribers', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('multi:event', handler1);
    bus.on('multi:event', handler2);

    bus.emit('multi:event', 'data');

    expect(handler1).toHaveBeenCalledWith('data');
    expect(handler2).toHaveBeenCalledWith('data');

    bus.off('multi:event', handler1);
    bus.off('multi:event', handler2);
  });

  it('unsubscribe function stops further notifications', () => {
    const handler = vi.fn();
    const unsub = bus.on('unsub:test', handler);

    bus.emit('unsub:test');
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.emit('unsub:test');
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });

  it('does not call handlers for different events', () => {
    const handler = vi.fn();
    bus.on('event:a', handler);
    bus.emit('event:b');

    expect(handler).not.toHaveBeenCalled();
    bus.off('event:a', handler);
  });

  it('handles errors in handlers gracefully', () => {
    const errorHandler = vi.fn(() => {
      throw new Error('handler error');
    });
    const normalHandler = vi.fn();

    bus.on('error:test', errorHandler);
    bus.on('error:test', normalHandler);

    // Should not throw — errors are caught internally
    bus.emit('error:test');

    expect(errorHandler).toHaveBeenCalled();
    expect(normalHandler).toHaveBeenCalled(); // second handler still runs

    bus.off('error:test', errorHandler);
    bus.off('error:test', normalHandler);
  });

  it('defines all expected event constants', () => {
    expect(Events.WORKSPACE_CHANGED).toBe('workspace:changed');
    expect(Events.WORKSPACE_CREATED).toBe('workspace:created');
    expect(Events.WORKSPACE_DELETED).toBe('workspace:deleted');
    expect(Events.WORKSPACE_RENAMED).toBe('workspace:renamed');
    expect(Events.BOOKMARK_CREATED).toBe('bookmark:created');
    expect(Events.BOOKMARK_REMOVED).toBe('bookmark:removed');
    expect(Events.BOOKMARK_CHANGED).toBe('bookmark:changed');
    expect(Events.BOOKMARK_MOVED).toBe('bookmark:moved');
    expect(Events.BOOKMARK_PINNED).toBe('bookmark:pinned');
    expect(Events.BOOKMARK_UNPINNED).toBe('bookmark:unpinned');
    expect(Events.TREE_REFRESH).toBe('tree:refresh');
    expect(Events.THEME_CHANGED).toBe('theme:changed');
  });
});
