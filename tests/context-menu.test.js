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

  // ── Submenu Support (body-appended on hover) ────────────

  it('renders a submenu item with chevron when children are provided', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Move to workspace…',
          children: [
            { label: 'Work', action: () => {} },
            { label: 'Personal', action: () => {} },
          ],
        },
      ],
    });

    const submenuItem = document.querySelector('.context-menu-item-submenu');
    expect(submenuItem).toBeTruthy();
    expect(submenuItem.textContent).toContain('Move to workspace…');

    const chevron = submenuItem.querySelector('.context-menu-submenu-chevron');
    expect(chevron).toBeTruthy();

    // Submenu is NOT in the DOM until hover
    expect(document.querySelector('.context-submenu')).toBeFalsy();

    // Trigger hover — submenu should appear in body
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const submenu = document.querySelector('.context-submenu');
    expect(submenu).toBeTruthy();

    const subItems = submenu.querySelectorAll('.context-menu-item');
    expect(subItems.length).toBe(2);
    expect(subItems[0].textContent).toBe('Work');
    expect(subItems[1].textContent).toBe('Personal');
  });

  it('submenu is not in DOM by default', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [{ label: 'Child', action: () => {} }],
        },
      ],
    });

    // Submenu only exists as a detached element until mouseenter
    expect(document.querySelector('.context-submenu')).toBeFalsy();
  });

  it('shows submenu on mouseenter', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [{ label: 'Child', action: () => {} }],
        },
      ],
    });

    const submenuItem = document.querySelector('.context-menu-item-submenu');
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    const submenu = document.querySelector('.context-submenu');
    expect(submenu).toBeTruthy();
    expect(submenu.classList.contains('context-submenu-visible')).toBe(true);
  });

  it('hides submenu on mouseleave', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [{ label: 'Child', action: () => {} }],
        },
      ],
    });

    const submenuItem = document.querySelector('.context-menu-item-submenu');

    // Show it first
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    expect(document.querySelector('.context-submenu')).toBeTruthy();

    // Leave to outside (relatedTarget null = left entirely)
    submenuItem.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, relatedTarget: null }));
    expect(document.querySelector('.context-submenu')).toBeFalsy();
  });

  it('calls submenu child action and closes menu on click', () => {
    let clicked = false;
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [{ label: 'Child Action', action: () => { clicked = true; } }],
        },
      ],
    });

    // Hover to reveal submenu
    const submenuItem = document.querySelector('.context-menu-item-submenu');
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    const submenu = document.querySelector('.context-submenu');
    const childItem = submenu.querySelector('.context-menu-item');
    childItem.click();

    expect(clicked).toBe(true);
    expect(document.querySelector('.context-menu')).toBeFalsy();
    expect(document.querySelector('.context-submenu')).toBeFalsy();
  });

  it('renders separators inside submenus', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [
            { label: 'A', action: () => {} },
            { separator: true },
            { label: 'B', action: () => {} },
          ],
        },
      ],
    });

    // Hover to reveal submenu
    const submenuItem = document.querySelector('.context-menu-item-submenu');
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    const submenu = document.querySelector('.context-submenu');
    const separators = submenu.querySelectorAll('.context-menu-separator');
    expect(separators.length).toBe(1);
    const subItems = submenu.querySelectorAll('.context-menu-item');
    expect(subItems.length).toBe(2);
  });

  it('does not render submenu for items with empty children array', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'No Children', children: [], action: () => {} },
      ],
    });

    const submenuItem = document.querySelector('.context-menu-item-submenu');
    expect(submenuItem).toBeFalsy();

    // Should render as a regular item
    const items = document.querySelectorAll('.context-menu-item');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toBe('No Children');
  });

  it('mixes regular items and submenu items correctly', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Rename', action: () => {} },
        { separator: true },
        {
          label: 'Move to…',
          children: [
            { label: 'Work', action: () => {} },
          ],
        },
        { label: 'Delete', danger: true, action: () => {} },
      ],
    });

    // Before hover: only menu items (no sub-items in DOM)
    const menuItems = document.querySelectorAll('.context-menu .context-menu-item');
    // Rename + Move to… (submenu parent) + Delete = 3
    expect(menuItems.length).toBe(3);

    const submenuParent = document.querySelector('.context-menu-item-submenu');
    expect(submenuParent.textContent).toContain('Move to…');

    const separators = document.querySelectorAll('.context-menu-separator');
    expect(separators.length).toBe(1);

    // After hover: sub-items appear in body
    submenuParent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const submenu = document.querySelector('.context-submenu');
    expect(submenu).toBeTruthy();
    const subItems = submenu.querySelectorAll('.context-menu-item');
    expect(subItems.length).toBe(1);
    expect(subItems[0].textContent).toBe('Work');
  });

  it('closeContextMenu removes active submenu from body', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [{ label: 'Child', action: () => {} }],
        },
      ],
    });

    // Hover to reveal submenu
    const submenuItem = document.querySelector('.context-menu-item-submenu');
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    expect(document.querySelector('.context-submenu')).toBeTruthy();

    // Close everything
    closeContextMenu();
    expect(document.querySelector('.context-menu')).toBeFalsy();
    expect(document.querySelector('.context-submenu')).toBeFalsy();
  });

  it('keeps submenu open when mouse moves from row to submenu', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        {
          label: 'Parent',
          children: [{ label: 'Child', action: () => {} }],
        },
      ],
    });

    const submenuItem = document.querySelector('.context-menu-item-submenu');
    submenuItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    const submenu = document.querySelector('.context-submenu');
    expect(submenu).toBeTruthy();

    // Mouse leaves row but enters the submenu — should stay open
    const submenuChild = submenu.querySelector('.context-menu-item');
    submenuItem.dispatchEvent(new MouseEvent('mouseleave', {
      bubbles: true,
      relatedTarget: submenuChild,
    }));
    // Submenu should still be in the DOM
    expect(document.querySelector('.context-submenu')).toBeTruthy();
    expect(submenu.classList.contains('context-submenu-visible')).toBe(true);
  });
});
