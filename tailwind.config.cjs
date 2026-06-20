const { heroui } = require("@heroui/react");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // HeroUI theme classes live in compiled .js/.mjs. npm may hoist the theme
    // package to the root or nest it under @heroui/react — match both, and
    // include .mjs (most theme files use that extension).
    "./node_modules/@heroui/theme/dist/**/*.{js,mjs}",
    "./node_modules/**/@heroui/theme/dist/**/*.{js,mjs}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Minecraft"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"Minecraft"', "ui-monospace", "monospace"],
      },
    },
  },
  darkMode: "class",
  plugins: [
    heroui({
      themes: {
        dark: {
          colors: {
            primary: {
              DEFAULT: "#43c463",
              foreground: "#07210f",
            },
          },
        },
      },
    }),
  ],
};
