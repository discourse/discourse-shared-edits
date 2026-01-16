import getCaretCoordinates from "../lib/caret-coordinates";

export default class CursorOverlay {
  constructor(textarea) {
    this.textarea = textarea;
    this.container = document.createElement("div");
    this.container.className = "shared-edits-cursor-overlay";

    this.updateContainerPosition();

    const parent = textarea.parentElement;
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(this.container);

    this.cursors = new Map();
    this.activeTypists = new Map();

    this.boundOnScroll = this.onScroll.bind(this);
    this.textarea.addEventListener("scroll", this.boundOnScroll, {
      passive: true,
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.updateContainerPosition();
      this.refresh();
    });
    this.resizeObserver.observe(textarea);
  }

  updateContainerPosition() {
    this.container.style.top = `${this.textarea.offsetTop}px`;
    this.container.style.left = `${this.textarea.offsetLeft}px`;
    this.container.style.width = `${this.textarea.offsetWidth}px`;
    this.container.style.height = `${this.textarea.offsetHeight}px`;
  }

  onScroll() {
    this.cursors.forEach((cursor) => this.renderCursor(cursor));
  }

  refresh() {
    const Y = window.Y;
    if (!Y || !Y.createAbsolutePositionFromRelativePosition) {
      return;
    }
    this.cursors.forEach((cursor) => {
      if (cursor.relativePosition && cursor.doc) {
        const absolutePosition = Y.createAbsolutePositionFromRelativePosition(
          cursor.relativePosition,
          cursor.doc
        );

        if (absolutePosition) {
          this.calculateCursorPosition(cursor, absolutePosition.index);
        }
      }
    });
  }

  updateCursor(clientId, origin, relativePosition, doc) {
    const Y = window.Y;
    if (!Y || !Y.createAbsolutePositionFromRelativePosition) {
      return;
    }
    let cursor = this.cursors.get(clientId);

    if (cursor && cursor.user.username !== origin.user_name) {
      cursor.element.remove();
      this.cursors.delete(clientId);
      cursor = null;
    }

    const isNew = !cursor;
    if (isNew) {
      cursor = this.createCursorElement({
        user_id: origin.user_id,
        user_name: origin.user_name,
      });
      this.cursors.set(clientId, cursor);
    }

    cursor.clientId = clientId;
    cursor.relativePosition = relativePosition;
    cursor.origin = origin;
    cursor.doc = doc;

    const absolutePosition = Y.createAbsolutePositionFromRelativePosition(
      relativePosition,
      doc
    );

    if (absolutePosition) {
      this.markTypist(clientId);
      this.calculateCursorPosition(cursor, absolutePosition.index);
    }

    if (isNew) {
      this.container.appendChild(cursor.element);
    }
  }

  markTypist(clientId) {
    const now = Date.now();
    const typist = this.activeTypists.get(clientId) || {};

    if (typist.timeout) {
      clearTimeout(typist.timeout);
    }

    typist.lastTyped = now;
    typist.timeout = setTimeout(() => {
      const cursor = this.cursors.get(clientId);
      if (cursor) {
        cursor.element.style.display = "none";
      }
    }, 5000);

    this.activeTypists.set(clientId, typist);
  }

  calculateCursorPosition(cursor, index) {
    const typist = this.activeTypists.get(cursor.clientId);
    const isActive = typist && Date.now() - typist.lastTyped < 5000;

    if (!isActive) {
      cursor.element.style.display = "none";
      return;
    }

    const viewCoords = this.getViewCoords(index);
    if (viewCoords) {
      cursor.absoluteTop = viewCoords.top;
      cursor.absoluteLeft = viewCoords.left;
      cursor.height = viewCoords.height;

      const isFirstLine = viewCoords.top < (viewCoords.height || 20) * 1.2;
      if (isFirstLine) {
        cursor.label.classList.add("shared-edits-cursor__label--bottom");
      } else {
        cursor.label.classList.remove("shared-edits-cursor__label--bottom");
      }
      cursor.element.style.display = "block";
      this.renderCursor(cursor);
    } else {
      cursor.element.style.display = "none";
    }
  }

  renderCursor(cursor) {
    const top = cursor.absoluteTop - this.textarea.scrollTop;
    const left = cursor.absoluteLeft - this.textarea.scrollLeft;

    cursor.element.style.transform = `translate(${left}px, ${top}px)`;
    if (cursor.height) {
      cursor.element.style.height = `${cursor.height}px`;
    }
  }

  getViewCoords(index) {
    return getCaretCoordinates(this.textarea, index);
  }

  createCursorElement(user) {
    const el = document.createElement("div");
    el.className = "shared-edits-cursor";

    const color = this.getColor(user.user_id);
    el.style.borderColor = color;

    const label = document.createElement("div");
    label.className = "shared-edits-cursor__label";
    label.textContent = user.user_name;
    label.style.backgroundColor = color;

    el.appendChild(label);

    return { element: el, label, user };
  }

  removeCursor(clientId) {
    const cursor = this.cursors.get(clientId);
    if (cursor) {
      cursor.element.remove();
      this.cursors.delete(clientId);
    }
  }

  clearPosition(clientId) {
    const cursor = this.cursors.get(clientId);
    if (cursor) {
      cursor.relativePosition = null;
      cursor.element.style.display = "none";
    }
  }

  getColor(id) {
    const index = (id || 0) % 7;
    return `var(--shared-edit-color-${index + 1})`;
  }

  destroy() {
    this.textarea.removeEventListener("scroll", this.boundOnScroll);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.container.remove();
    this.cursors.clear();
    this.activeTypists.clear();
  }
}
