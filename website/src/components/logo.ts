/**
 * FlareLens 3-layer isometric stack mark, shared across Header.astro,
 * DocsLayout.astro, and Satori OpenGraph PNG cards (src/pages/og/_card.ts).
 */
export const logo = {
  width: 24,
  height: 24,
  paths: [
    // Top isometric plane (filled diamond)
    "M12 2.4L2.6 7.1 12 11.8 21.4 7.1 12 2.4Z",
    // Middle data plane chevron
    "M2.6 11.8 4.5 10.85 12 14.6 19.5 10.85 21.4 11.8 12 16.5 2.6 11.8Z",
    // Bottom mesh layer chevron
    "M2.6 16.5 4.5 15.55 12 19.3 19.5 15.55 21.4 16.5 12 21.2 2.6 16.5Z",
  ],
};
