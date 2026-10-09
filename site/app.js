async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Restricted contexts (non-secure origins) still have a selection fallback.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// Copy buttons stay hidden until JavaScript can wire them up.
for (const button of document.querySelectorAll("button[data-copy]")) {
  button.hidden = false;
  button.setAttribute("aria-live", "polite");
  let reset;
  button.addEventListener("click", async () => {
    const ok = await copyText(button.dataset.copy ?? "");
    button.textContent = ok ? "Copied" : "Copy failed";
    if (ok) button.dataset.state = "copied";
    else delete button.dataset.state;
    clearTimeout(reset);
    reset = setTimeout(() => {
      button.textContent = "Copy";
      delete button.dataset.state;
    }, 1800);
  });
}
