# TradeStation & Alpaca Automated Bracket Trading Dashboard

A real-time desktop and web trading application built with Node.js, Express, and Electron. This dashboard integrates **TradeStation Order Execution APIs** for bracket order management (OSO / Take Profit & Stop Loss) alongside **Alpaca Realtime WebSockets** for live market price streaming and automated position sizing.

![Trade Execution Dashboard UI](docs/screenshot.png)

---

## Features

* **TradeStation OSO Brackets:** Submits primary entry orders (Limit or Stop Market) tied to dynamic child exit legs (Take Profit & Stop Loss).
* **Alpaca Live Market Stream:** Connects to Alpaca's IEX WebSocket feeds (`wss://stream.data.alpaca.markets`) for sub-second real-time price updates, day highs, and day lows.
* **Dynamic Position Sizing:** Automatically calculates quantity based on fixed account risk ($) and risk per share, respecting real-time buying power limits.
* **Order Status Monitoring:** Displays HTTP response codes, primary/child Order IDs, and immediately checks live order statuses post-submission.
* **Interactive Live Order Modal:**
  * Tracks unrealized P/L ($ and %) updated every second based on streaming Alpaca prices.
  * Polls TradeStation order leg statuses until all orders terminate or market close.
  * Supports live order modifications (Update Stop Loss / Take Profit) or instant single-click cancellation of all legs via TradeStation's REST API.
* **OAuth Token Management:** Automated OAuth 2.0 background token refresh cycle with persistence to disk (`.token`).

---

## Tech Stack

* **Backend / Server:** Node.js, Express.js, Axios
* **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3
* **Integrations:** TradeStation API v3, Alpaca Markets Market Data API v2
* **Desktop Framework:** Electron

---

## Setup & Installation

### Prerequisites

* Node.js (v18+ recommended)
* A active TradeStation Developer account & API credentials
* An Alpaca API Key and Secret Key

### Installation

1. **Clone the Repository:**
   ```bash
   git clone [https://github.com/your-username/trade-app.git](https://github.com/your-username/trade-app.git)
   cd trade-app
