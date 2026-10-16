/** React-free native SVG adapter. Motion is vendored from packages/ui. */
export function forSvgXml(svg: string): string {
  return svg.replace(/^<svg class="[^"]*" /, '<svg ').replace(' focusable="false" aria-hidden="true">', '>');
}
