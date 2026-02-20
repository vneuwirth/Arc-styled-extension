// Tests for the context menu component

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { showContextMenu, closeContextMenu } from '../sidepanel/components/context-menu.js';

describe('ContextMenu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    closeContextMenu();
  });

  it('renders a context menu with items', () => {
    showContextMenu({
      x: 100,
      y: 200,
      items: [
        { label: 'Rename', action: () => {} },
        { label: 'Delete', danger: true, action: () => {} },
      ],
    });

    const menu = document.querySelector('.context-menu');
    expect(menu).toBeTruthy();
    const items = menu.querySelectorAll('.context-menu-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('Rename');
    expect(items[1].textContent).toBe('Delete');
  });

  it('positions the menu at the given coordinates', () => {
    showContextMenu({
      x: 150,
      y: 250,
      items: [{ label: 'Test', action: () => {} }],
    });

    const menu = document.querySelector('.context-menu');
    expect(menu.style.left).toBe('150px');
    expect(menu.style.top).toBe('250px');
  });

  it('marks danger items with the danger class', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Safe', action: () => {} },
        { label: 'Dangerous', danger: true, action: () => {} },
      ],
    });

    const items = document.querySelectorAll('.context-menu-item');
    expect(items[0].classList.contains('context-menu-item-danger')).toBe(false);
    expect(items[1].classList.contains('context-menu-item-danger')).toBe(true);
  });

  it('renders separators', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Above', action: () => {} },
        { separator: true },
        { label: 'Below', action: () => {} },
      ],
    });

    const separators = document.querySelectorAll('.context-menu-separator');
    expect(separators.length).toBe(1);
    const items = document.querySelectorAll('.context-menu-item');
    expect(items.length).toBe(2);
  });

  it('calls the action and closes on item click', () => {
    let called = false;
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Action', action: () => { called = true; } }],
    });

    const item = document.querySelector('.context-menu-item');
    item.click();

    expect(called).toBe(true);
    expect(document.querySelector('.context-menu')).toBeFalsy();
  });

  it('only allows one menu at a time', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'First', action: () => {} }],
    });

    showContextMenu({
      x: 50,
      y: 50,
      items: [{ label: 'Second', action: () => {} }],
    });

    const menus = document.querySelectorAll('.context-menu');
    expect(menus.length).toBe(1);
    expect(menus[0].querySelector('.context-menu-item').textContent).toBe('Second');
  });

  it('closeContextMenu removes the menu', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Test', action: () => {} }],
    });

    expect(document.querySelector('.context-menu')).toBeTruthy();
    closeContextMenu();
    expect(document.querySelector('.context-menu')).toBeFalsy();
  });

  it('does nothing when closeContextMenu is called without a menu', () => {
    // Should not throw
    closeContextMenu();
    closeContextMenu();
  });
});
