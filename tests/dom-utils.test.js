// Tests for DOM utility functions

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { el, clearChildren } from '../sidepanel/utils/dom.js';

describe('DOM Utilities', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ── el() ───────────────────────────────────────

  describe('el()', () => {
    it('creates an element with the given tag', () => {
      const div = el('div');
      expect(div.tagName).toBe('DIV');
    });

    it('sets text content', () => {
      const span = el('span', { text: 'Hello' });
      expect(span.textContent).toBe('Hello');
    });

    it('adds a single className', () => {
      const div = el('div', { className: 'my-class' });
      expect(div.classList.contains('my-class')).toBe(true);
    });

    it('adds multiple classNames from array', () => {
      const div = el('div', { className: ['class-a', 'class-b'] });
      expect(div.classList.contains('class-a')).toBe(true);
      expect(div.classList.contains('class-b')).toBe(true);
    });

    it('handles space-separated className strings (DOMTokenList bug fix)', () => {
      // This was the critical bug — classList.add('foo bar') throws
      const div = el('div', { className: 'item-icon folder-icon' });
      expect(div.classList.contains('item-icon')).toBe(true);
      expect(div.classList.contains('folder-icon')).toBe(true);
    });

    it('handles space-separated strings in arrays', () => {
      const div = el('div', { className: ['base-class', 'multi one two'] });
      expect(div.classList.contains('base-class')).toBe(true);
      expect(div.classList.contains('multi')).toBe(true);
      expect(div.classList.contains('one')).toBe(true);
      expect(div.classList.contains('two')).toBe(true);
    });

    it('filters out empty strings and falsy values', () => {
      const div = el('div', { className: ['valid', '', null, undefined, 'also-valid'] });
      expect(div.classList.contains('valid')).toBe(true);
      expect(div.classList.contains('also-valid')).toBe(true);
      expect(div.classList.length).toBe(2);
    });

    it('sets inline styles', () => {
      const div = el('div', { style: { paddingLeft: '16px', color: 'red' } });
      expect(div.style.paddingLeft).toBe('16px');
      expect(div.style.color).toBe('red');
    });

    it('sets data attributes', () => {
      const div = el('div', { dataset: { id: '42', type: 'folder' } });
      expect(div.dataset.id).toBe('42');
      expect(div.dataset.type).toBe('folder');
    });

    it('sets regular attributes', () => {
      const input = el('input', { attrs: { type: 'text', placeholder: 'Name' } });
      expect(input.getAttribute('type')).toBe('text');
      expect(input.getAttribute('placeholder')).toBe('Name');
    });

    it('attaches event listeners', () => {
      const handler = vi.fn();
      const btn = el('button', { events: { click: handler } });
      btn.click();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('appends children', () => {
      const child1 = el('span', { text: 'A' });
      const child2 = el('span', { text: 'B' });
      const parent = el('div', { children: [child1, child2] });
      expect(parent.children.length).toBe(2);
      expect(parent.children[0].textContent).toBe('A');
    });
  });

  // ── clearChildren() ────────────────────────────

  describe('clearChildren()', () => {
    it('removes all children from an element', () => {
      const parent = el('div', {
        children: [el('span'), el('span'), el('span')],
      });
      expect(parent.children.length).toBe(3);

      clearChildren(parent);
      expect(parent.children.length).toBe(0);
    });

    it('does not throw on empty element', () => {
      const div = el('div');
      clearChildren(div);
      expect(div.children.length).toBe(0);
    });
  });
});
