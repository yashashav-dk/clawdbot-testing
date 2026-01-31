"use client";

import { useState } from "react";

/**
 * Target app for the SRE Dreamer demo.
 *
 * When NEXT_PUBLIC_ENABLE_BUG=true (or the toggle is clicked), a transparent
 * overlay div with a high z-index is rendered on top of the page. This creates
 * the "invisible outage" — the page looks normal, returns 200 OK, but the
 * Login button (and everything else) is unclickable because the overlay
 * intercepts pointer events.
 *
 * This is the classic CSS Stacking Context / Z-Index Deadlock.
 */

const BUG_ENABLED_BY_ENV = process.env.NEXT_PUBLIC_ENABLE_BUG === "true";

export default function Home() {
  const [bugActive, setBugActive] = useState(BUG_ENABLED_BY_ENV);
  const [loginClicked, setLoginClicked] = useState(false);

  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa" }}>
      {/* === THE BUG: Invisible overlay that blocks all clicks === */}
      {bugActive && (
        <div
          id="ghost-overlay"
          data-testid="ghost-overlay"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            zIndex: 9999,
            background: "transparent",
            // This is the killer — it captures all pointer events
            pointerEvents: "auto",
          }}
        />
      )}

      {/* Header */}
      <header
        style={{
          background: "#1a1a2e",
          color: "white",
          padding: "16px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>ShopDemo</h1>
        <nav style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <a href="#" style={{ color: "#e0e0e0", textDecoration: "none" }}>
            Products
          </a>
          <a href="#" style={{ color: "#e0e0e0", textDecoration: "none" }}>
            About
          </a>
          <button
            id="login-btn"
            data-testid="login-btn"
            onClick={() => setLoginClicked(true)}
            style={{
              background: "#e94560",
              color: "white",
              border: "none",
              padding: "8px 20px",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "1rem",
              fontWeight: 600,
            }}
          >
            Login
          </button>
        </nav>
      </header>

      {/* Login success feedback */}
      {loginClicked && (
        <div
          data-testid="login-success"
          style={{
            background: "#4caf50",
            color: "white",
            padding: "12px 32px",
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          Login button clicked successfully!
        </div>
      )}

      {/* Main content */}
      <main style={{ maxWidth: "1000px", margin: "0 auto", padding: "40px 20px" }}>
        <section style={{ textAlign: "center", marginBottom: "48px" }}>
          <h2 style={{ fontSize: "2rem", color: "#1a1a2e" }}>
            Welcome to ShopDemo
          </h2>
          <p style={{ color: "#666", fontSize: "1.1rem", maxWidth: "600px", margin: "0 auto" }}>
            Your one-stop shop for demo products. Click Login to get started.
          </p>
        </section>

        {/* Product cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "24px",
          }}
        >
          {[
            { name: "Widget Pro", price: "$29.99", desc: "The ultimate widget for pros" },
            { name: "Gadget Lite", price: "$14.99", desc: "Lightweight and reliable" },
            { name: "Doohickey X", price: "$49.99", desc: "Next-gen doohickey technology" },
          ].map((product) => (
            <div
              key={product.name}
              style={{
                background: "white",
                borderRadius: "12px",
                padding: "24px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
              }}
            >
              <div
                style={{
                  height: "160px",
                  background: "#e8e8e8",
                  borderRadius: "8px",
                  marginBottom: "16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#999",
                  fontSize: "0.9rem",
                }}
              >
                Product Image
              </div>
              <h3 style={{ margin: "0 0 8px 0", color: "#1a1a2e" }}>{product.name}</h3>
              <p style={{ color: "#666", margin: "0 0 12px 0", fontSize: "0.9rem" }}>
                {product.desc}
              </p>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontWeight: 700, color: "#e94560", fontSize: "1.2rem" }}>
                  {product.price}
                </span>
                <button
                  data-testid={`add-to-cart-${product.name.toLowerCase().replace(/\s/g, "-")}`}
                  style={{
                    background: "#1a1a2e",
                    color: "white",
                    border: "none",
                    padding: "8px 16px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.9rem",
                  }}
                >
                  Add to Cart
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Debug toggle (only visible in dev) */}
      {process.env.NODE_ENV === "development" && (
        <div
          style={{
            position: "fixed",
            bottom: "16px",
            right: "16px",
            background: bugActive ? "#e94560" : "#4caf50",
            color: "white",
            padding: "8px 16px",
            borderRadius: "8px",
            cursor: "pointer",
            fontSize: "0.8rem",
            fontWeight: 600,
            zIndex: 99999,
            // Must be above the ghost overlay for testing
            pointerEvents: "auto",
          }}
          onClick={() => setBugActive(!bugActive)}
        >
          Bug: {bugActive ? "ON" : "OFF"}
        </div>
      )}

      {/* Health check endpoint marker */}
      <div data-testid="health-ok" style={{ display: "none" }}>
        OK
      </div>

      {/* Footer */}
      <footer
        style={{
          background: "#1a1a2e",
          color: "#888",
          textAlign: "center",
          padding: "24px",
          marginTop: "60px",
          fontSize: "0.85rem",
        }}
      >
        ShopDemo &copy; 2026 &mdash; SRE Dreamer Target Application
      </footer>
    </div>
  );
}
