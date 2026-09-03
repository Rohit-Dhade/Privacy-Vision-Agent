/**
 * content/coordinateMapper.js
 *
 * Converts a DOM bounding box (CSS pixels, relative to the viewport)
 * into screenshot pixel coordinates.
 *
 * Loaded in TWO contexts:
 *   - the content script (not strictly required there, but kept
 *     available for symmetry / future use, e.g. if redaction ever
 *     moves back into the page context)
 *   - the popup, where the actual screenshot <img>/<canvas> lives and
 *     where the real scaling happens today
 *
 * See utils/geometry.js `scaleRectToImage` for why we scale using the
 * decoded image's actual pixel size rather than devicePixelRatio alone
 * (it self-corrects for zoom + DPR + OS scaling in one measurement).
 */
(function (root) {
  /**
   * @param {{x:number,y:number,width:number,height:number}} domBbox - viewport-relative CSS px box
   * @param {{width:number,height:number}} viewport - viewport CSS size captured at extraction time
   * @param {number} imageWidth - decoded screenshot width in pixels
   * @param {number} imageHeight - decoded screenshot height in pixels
   * @param {number} [padding=4] - extra px to grow the box by, to avoid partial leakage at edges
   */
  function mapDomBoxToScreenshot(domBbox, viewport, imageWidth, imageHeight, padding = 4) {
    const scaled = root.__BA_Geometry.scaleRectToImage(domBbox, viewport, imageWidth, imageHeight);
    const scaleAvg = (imageWidth / viewport.width + imageHeight / viewport.height) / 2;
    const padded = root.__BA_Geometry.padRect(scaled, padding * scaleAvg);
    return root.__BA_Geometry.clampRect(padded, imageWidth, imageHeight);
  }
  /**
   * Converts a screenshot pixel point back into viewport CSS coordinates.
   * Self-corrects for devicePixelRatio, OS scaling, and zoom.
   *
   * @param {{x:number,y:number}} point - point in screenshot pixel space
   * @param {{width:number,height:number}} viewport - viewport CSS size
   * @param {number} imageWidth - screenshot image width
   * @param {number} imageHeight - screenshot image height
   * @returns {{x:number,y:number}|null}
   */
  function mapScreenshotPointToViewport(point, viewport, imageWidth, imageHeight) {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return null;
    if (!viewport || !viewport.width || !viewport.height || !imageWidth || !imageHeight) return null;
    const scaleX = viewport.width / imageWidth;
    const scaleY = viewport.height / imageHeight;
    return {
      x: point.x * scaleX,
      y: point.y * scaleY
    };
  }

  root.__BA_CoordinateMapper = {
    mapDomBoxToScreenshot,
    mapScreenshotPointToViewport
  };
})(typeof window !== 'undefined' ? window : self);
