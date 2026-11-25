const assert = require('assert');
const vm = require('vm');

function makeEl({ tag = 'SPAN', testid = null, cls = '', attrs = {}, parent = null, children = [], text = '' } = {}) {
  const mergedAttrs = { ...attrs };
  if (testid) mergedAttrs['data-testid'] = testid;
  const el = {
    nodeName: tag,
    nodeType: 1,
    className: cls,
    isContentEditable: false,
    _attrs: mergedAttrs,
    parentElement: parent,
    parentNode: parent,
    children,
    firstChild: children[0] || null,
    _text: text,
    get textContent() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent || '').join('');
    },
    hasAttribute(k) { return k in this._attrs; },
    getAttribute(k) { return this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    matches(sel) {
      const classes = (this.className || '').split(/\s+/).filter(Boolean);
      return sel.split(',').some((raw) => {
        const s = raw.trim();
        if (!s) return false;
        if (s === this.nodeName.toLowerCase()) return true;
        if (s === '#raw') return this._attrs.id === 'raw';
        const exactAttr = s.match(/^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
        if (exactAttr) return this._attrs[exactAttr[1]] === exactAttr[2];
        const containsAttr = s.match(/^\[([a-zA-Z0-9_-]+)\*="([^"]+)"\]$/);
        if (containsAttr) return String(this._attrs[containsAttr[1]] || '').includes(containsAttr[2]);
        const hasAttr = s.match(/^\[([a-zA-Z0-9_-]+)\]$/);
        if (hasAttr) return hasAttr[1] in this._attrs;
        if (/^(?:[a-z]+\.)?(?:\.[a-zA-Z0-9_-]+)+$/.test(s)) {
          const parts = s.split('.');
          const tagPart = parts[0];
          if (tagPart && tagPart.toUpperCase() !== this.nodeName) return false;
          return parts.slice(1).every((c) => classes.includes(c));
        }
        return false;
      });
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches && cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      const wanted = sel.match(/\[data-testid="([^"]+)"\]/);
      if (!wanted) return null;
      const visit = (node) => {
        if (node._attrs && node._attrs['data-testid'] === wanted[1]) return node;
        for (const c of (node.children || [])) {
          const hit = visit(c);
          if (hit) return hit;
        }
        return null;
      };
      return visit(this);
    },
    querySelectorAll(sel) {
      const results = [];
      const visit = (node) => {
        if (node !== this && node.matches && node.matches(sel)) results.push(node);
        for (const c of (node.children || [])) visit(c);
      };
      visit(this);
      return results;
    }
  };
  for (let i = 0; i < children.length; i++) {
    children[i].parentElement = el;
    children[i].parentNode = el;
    children[i].previousSibling = i > 0 ? children[i - 1] : null;
    children[i].nextSibling = i + 1 < children.length ? children[i + 1] : null;
  }
  return el;
}

function makeTextNode(val, parent = null, prev = null, next = null) {
  return {
    nodeType: 3,
    nodeValue: val,
    get textContent() { return this.nodeValue; },
    parentElement: parent,
    parentNode: parent,
    previousSibling: prev,
    nextSibling: next
  };
}

function loadEngineInSandbox(i18nCode, protocol = 'app:', docTitle = 'Antigravity') {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { location: { protocol } },
    location: { protocol },
    document: {
      title: docTitle,
      documentElement: null,
      body: null,
      createTreeWalker: () => ({ nextNode: () => null })
    },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (cb) => cb(),
  };
  sandbox.window.document = sandbox.document;

  const testWrapped = i18nCode.replace(
    "    if (document.readyState === 'loading')",
    "    globalThis.__i18nTest = { translateString, translateNode, translateElementAttrs, SPLIT_TEXT_TRANSLATOR, ATTR_DICT, EXACT_DICT, PRESERVE_SET, shouldIgnoreElement, shouldIgnoreTextParent, shouldIgnoreAttrElement, isSwarmContext };\n    return;\n    if (document.readyState === 'loading')"
  );
  vm.runInNewContext(testWrapped, sandbox);
  assert(sandbox.__i18nTest, 'Failed to extract i18n runtime API in VM');
  return sandbox.__i18nTest;
}

function createMockDomEnv() {
  function DomNode(nodeType, tag) {
    this.nodeType = nodeType;
    this.nodeName = tag || '';
    this.parentElement = null;
    this.parentNode = null;
    this.childNodes = [];
    this.isConnected = false;
    this._attrs = {};
    this.className = '';
    this.id = '';
    this.isContentEditable = false;
  }
  Object.defineProperty(DomNode.prototype, 'children', {
    get() { return this.childNodes.filter((c) => c.nodeType === 1); }
  });
  Object.defineProperty(DomNode.prototype, 'childElementCount', {
    get() { return this.children.length; }
  });
  Object.defineProperty(DomNode.prototype, 'firstChild', {
    get() { return this.childNodes[0] || null; }
  });
  Object.defineProperty(DomNode.prototype, 'nextSibling', {
    get() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
    }
  });
  Object.defineProperty(DomNode.prototype, 'previousSibling', {
    get() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
    }
  });
  Object.defineProperty(DomNode.prototype, 'textContent', {
    get() {
      if (this.nodeType === 3) return this.nodeValue || '';
      return this.childNodes.map((c) => c.textContent).join('');
    }
  });
  DomNode.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); };
  DomNode.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; };
  DomNode.prototype.setAttribute = function (k, v) {
    const valStr = String(v);
    this._attrs[k] = valStr;
    if (k === 'class') this.className = valStr;
    if (k === 'id') this.id = valStr;
  };
  DomNode.prototype.removeAttribute = function (k) {
    delete this._attrs[k];
    if (k === 'class') this.className = '';
    if (k === 'id') this.id = '';
  };
  DomNode.prototype.matches = function (sel) {
    if (this.nodeType !== 1 || !sel) return false;
    const classes = (this.className || (this._attrs && this._attrs.class) || '').split(/\s+/).filter(Boolean);
    return sel.split(',').some((raw) => {
      let s = raw.trim();
      if (!s) return false;
      const tagM = s.match(/^([a-zA-Z0-9_-]+)/);
      if (tagM) {
        if (this.nodeName.toLowerCase() !== tagM[1].toLowerCase()) return false;
        s = s.slice(tagM[0].length);
      }
      while (s.length > 0) {
        if (s[0] === '.') {
          const clsM = s.match(/^\.([a-zA-Z0-9_-]+)/);
          if (!clsM || !classes.includes(clsM[1])) return false;
          s = s.slice(clsM[0].length);
        } else if (s[0] === '#') {
          const idM = s.match(/^#([a-zA-Z0-9_-]+)/);
          const nodeId = this.id || this._attrs.id || '';
          if (!idM || nodeId !== idM[1]) return false;
          s = s.slice(idM[0].length);
        } else if (s[0] === '[') {
          const attrM = s.match(/^\[([a-zA-Z0-9_-]+)(?:(\*)?="([^"]*)")?\]/);
          if (!attrM) return false;
          const attrName = attrM[1];
          const op = attrM[2];
          const expected = attrM[3];
          const has = Object.prototype.hasOwnProperty.call(this._attrs, attrName);
          if (!has) return false;
          if (expected !== undefined) {
            const actual = String(this._attrs[attrName]);
            if (op === '*' ? !actual.includes(expected) : actual !== expected) return false;
          }
          s = s.slice(attrM[0].length);
        } else {
          return false;
        }
      }
      return true;
    });
  };
  DomNode.prototype.closest = function (sel) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };
  DomNode.prototype.querySelector = function (sel) {
    const visit = (node) => {
      if (node !== this && node.nodeType === 1 && node.matches(sel)) return node;
      for (const c of node.childNodes) {
        const hit = visit(c);
        if (hit) return hit;
      }
      return null;
    };
    return visit(this);
  };
  DomNode.prototype.querySelectorAll = function (sel) {
    const out = [];
    const visit = (node) => {
      if (node !== this && node.nodeType === 1 && node.matches(sel)) out.push(node);
      for (const c of node.childNodes) visit(c);
    };
    visit(this);
    return out;
  };
  DomNode.prototype.addEventListener = function (ev, fn) {
    this._listeners = this._listeners || {};
    this._listeners[ev] = this._listeners[ev] || [];
    this._listeners[ev].push(fn);
  };
  DomNode.prototype.appendChild = function (child) {
    if (child.nodeType === 11) {
      const moved = [...child.childNodes];
      child.childNodes.length = 0;
      for (const c of moved) this.appendChild(c);
      return child;
    }
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    const propagateConn = (n, val) => {
      n.isConnected = val;
      for (const c of n.childNodes) propagateConn(c, val);
    };
    propagateConn(child, this.isConnected);
    this.childNodes.push(child);
    return child;
  };
  DomNode.prototype.insertBefore = function (newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    newNode.parentNode = this;
    newNode.parentElement = this.nodeType === 1 ? this : null;
    const propagateConn = (n, val) => {
      n.isConnected = val;
      for (const c of n.childNodes) propagateConn(c, val);
    };
    propagateConn(newNode, this.isConnected);
    this.childNodes.splice(idx >= 0 ? idx : this.childNodes.length, 0, newNode);
    return newNode;
  };

  function DomElement(tag) { DomNode.call(this, 1, tag); }
  DomElement.prototype = Object.create(DomNode.prototype);
  DomElement.prototype.append = function (...items) {
    for (const item of items) {
      if (typeof item === 'string') {
        const tn = new DomNode(3);
        tn.nodeValue = item;
        this.appendChild(tn);
      } else {
        this.appendChild(item);
      }
    }
  };
  DomElement.prototype.prepend = DomElement.prototype.append;
  DomElement.prototype.replaceChildren = function (...items) {
    this.childNodes.length = 0;
    this.append(...items);
  };
  DomElement.prototype.attachShadow = function () {
    const sr = new DomNode(11);
    sr.isConnected = this.isConnected;
    this.shadowRoot = sr;
    return sr;
  };

  const makeText = (val) => {
    const tn = new DomNode(3);
    tn.nodeValue = val;
    return tn;
  };

  return { DomNode, DomElement, makeText };
}

module.exports = { makeEl, makeTextNode, loadEngineInSandbox, createMockDomEnv };
