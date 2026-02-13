const properties = [
  "direction",
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "MozTabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "wordWrap",
];

const isBrowser = typeof window !== "undefined";

export default function getCaretCoordinates(element, position) {
  if (!isBrowser) {
    throw new Error(
      "getCaretCoordinates should only be called in a browser context"
    );
  }

  const div = document.createElement("div");
  div.id = "input-textarea-caret-position-mirror-div";
  document.body.appendChild(div);

  const style = div.style;
  const computed = window.getComputedStyle(element);

  properties.forEach((prop) => {
    style[prop] = computed[prop];
  });

  style.whiteSpace = "pre-wrap";
  style.overflowWrap = "break-word";
  style.position = "absolute";
  style.visibility = "hidden";

  // Use getBoundingClientRect to get the precise fractional width of the element.
  // This is critical because clientWidth rounds to an integer, which can cause
  // incorrect line wrapping in the mirror div if the actual width is fractional
  // (common on high-DPI displays or with percentage widths).
  const rect = element.getBoundingClientRect();
  style.width = `${rect.width}px`;
  style.boxSizing = "border-box";
  style.overflow = "hidden";

  // Adjust padding-right to account for the scrollbar if it exists.
  // The mirror div has overflow:hidden, so it won't have a scrollbar.
  // We must reserve that space manually to match the text wrapping area.
  // offsetWidth and clientWidth are integers, so the scrollbar width calculation is safe.
  const borderLeft = parseFloat(computed.borderLeftWidth);
  const borderRight = parseFloat(computed.borderRightWidth);
  const scrollbarWidth =
    element.offsetWidth - element.clientWidth - borderLeft - borderRight;

  if (scrollbarWidth > 0) {
    style.paddingRight = `${
      parseFloat(computed.paddingRight) + scrollbarWidth
    }px`;
  }

  let pos = parseInt(position, 10);
  if (isNaN(pos)) {
    pos = 0;
  }

  div.textContent = element.value.substring(0, pos);

  const span = document.createElement("span");
  // Use Zero Width Space to prevent the probe character from causing a wrap
  // if the line is exactly full.
  span.textContent = element.value.substring(pos) || "\u200b";
  div.appendChild(span);

  const coordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    height: parseInt(computed.lineHeight, 10),
  };

  if (isNaN(coordinates.height)) {
    coordinates.height = parseInt(computed.fontSize, 10) * 1.2; // Fallback
  }

  document.body.removeChild(div);

  return coordinates;
}
