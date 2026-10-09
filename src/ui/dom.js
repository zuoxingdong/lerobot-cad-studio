/* The one `document.createElement` helper every UI module uses.  Needs the DOM only. */

/** An element with an optional class and text child. */
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
