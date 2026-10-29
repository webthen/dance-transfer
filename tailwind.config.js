/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '15%, 45%, 75%': { transform: 'translateX(-8px)' },
          '30%, 60%, 90%': { transform: 'translateX(8px)' },
        },
      },
      animation: {
        shake: 'shake 0.45s cubic-bezier(.36,.07,.19,.97) both',
      },
    },
  },
  plugins: [],
};
