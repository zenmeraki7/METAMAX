export default function AutomationIllustration() {
  return (
    <svg
      className="ma-hero-illustration"
      width="344"
      height="118"
      viewBox="0 0 344 118"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="ma-art-bg"
          x1="0"
          y1="0"
          x2="344"
          y2="118"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EAF3FF" />
          <stop offset="1" stopColor="#E5EFFD" />
        </linearGradient>

        <linearGradient id="ma-art-blue" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#70A7FF" />
          <stop offset="1" stopColor="#487DDB" />
        </linearGradient>

        <filter id="ma-art-shadow" x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow
            dx="0"
            dy="4"
            stdDeviation="5"
            floodColor="#6B91BE"
            floodOpacity=".16"
          />
        </filter>
      </defs>

      <rect width="344" height="118" rx="18" fill="url(#ma-art-bg)" />

      {/* Calendar */}
      <g filter="url(#ma-art-shadow)">
        <rect x="174" y="16" width="106" height="88" rx="9" fill="#FFFFFF" />
        <path
          d="M174 25C174 20 178 16 183 16H271C276 16 280 20 280 25V37H174V25Z"
          fill="url(#ma-art-blue)"
        />

        <rect x="190" y="10" width="5" height="15" rx="2.5" fill="#91BAFC" />
        <rect x="257" y="10" width="5" height="15" rx="2.5" fill="#91BAFC" />

        {[
          [190, 45],
          [214, 45],
          [238, 45],
          [262, 45],
          [190, 64],
          [214, 64],
          [238, 64],
          [262, 64],
          [190, 83],
          [214, 83],
          [238, 83],
          [262, 83],
        ].map(([x, y]) => (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="13"
            height="12"
            rx="3"
            fill="#DCEAFF"
          />
        ))}
      </g>

      {/* Clock */}
      <circle
        cx="112"
        cy="28"
        r="19"
        fill="#FFFFFF"
        stroke="#6C9EF6"
        strokeWidth="3"
      />
      <path
        d="M112 17V29L119 34"
        stroke="#6C9EF6"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Decorative sparkles */}
      <path
        d="M151 18L154 25L161 28L154 31L151 38L148 31L141 28L148 25L151 18Z"
        fill="#A2C7FF"
      />
      <circle cx="163" cy="53" r="3" fill="#C1D7FB" />

      {/* Product card */}
      <g filter="url(#ma-art-shadow)">
        <rect x="46" y="57" width="132" height="57" rx="9" fill="#FFFFFF" />

        {/* Green shirt */}
        <path
          d="M73 74L81 69L89 71H94L102 69L110 74L106 84L100 82V102H83V82L77 84L73 74Z"
          fill="#51D39E"
        />

        <rect x="111" y="73" width="32" height="5" rx="2.5" fill="#E0E6ED" />
        <rect x="111" y="85" width="50" height="5" rx="2.5" fill="#E3EAF2" />
        <rect x="111" y="97" width="37" height="5" rx="2.5" fill="#BDD4F9" />
      </g>

      {/* Gear */}
      <g transform="translate(311 78)">
        <path
          d="M-4-20H4L6-15L11-13L16-16L21-10L17-5L19 0L24 2V10L19 12L17 17L20 21L14 26L9 23L4 25L2 30H-6L-8 25L-13 23L-18 26L-23 20L-19 15L-21 10L-26 8V0L-21-2L-19-7L-22-12L-16-18L-11-15L-6-17L-4-20Z"
          fill="#5E8BD7"
          transform="scale(.72)"
        />
        <circle r="7" fill="#DCEAFF" />
      </g>
    </svg>
  );
}
