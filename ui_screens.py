import os
import json
import requests
import numpy as np
import pyqtgraph as pg
from pyqtgraph.Qt import QtCore

from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, 
    QLineEdit, QPushButton, QMessageBox, QFrame, QComboBox, QMenu
)
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QIntValidator, QDoubleValidator

from config import PREFS_FILE
from ui_components import CandlestickItem
from network_workers import TradeStationAuthWorker, ChartDataWorker, AccountBalanceWorker

class LoginScreen(QWidget):
    def __init__(self, on_login_callback):
        super().__init__()
        self.on_login_callback = on_login_callback
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        title = QLabel("TradeStation API Terminal")
        title.setStyleSheet("font-size: 20px; font-weight: bold; margin-bottom: 15px;")
        layout.addWidget(title, alignment=Qt.AlignmentFlag.AlignCenter)

        self.status_lbl = QLabel("Checking local token persistence...")
        layout.addWidget(self.status_lbl, alignment=Qt.AlignmentFlag.AlignCenter)

        self.connect_btn = QPushButton("Connect to TradeStation")
        self.connect_btn.setStyleSheet("padding: 10px 20px; font-size: 14px;")
        self.connect_btn.clicked.connect(self.start_auth_flow)
        layout.addWidget(self.connect_btn, alignment=Qt.AlignmentFlag.AlignCenter)

        self.setLayout(layout)

    def start_auth_flow(self):
        self.connect_btn.setEnabled(False)
        self.status_lbl.setText("Verifying connection credentials...")
        self.worker = TradeStationAuthWorker()
        self.worker.auth_success.connect(self.handle_success)
        self.worker.auth_failed.connect(self.handle_failure)
        self.worker.start()

    def handle_success(self, access_token):
        self.on_login_callback(access_token)

    def handle_failure(self, error_msg):
        QMessageBox.critical(self, "Connection Error", f"Auth failed:\n{error_msg}")
        self.connect_btn.setEnabled(True)
        self.status_lbl.setText("❌ Session expired or unauthorized.")


class DashboardScreen(QWidget):
    def __init__(self, access_token):
        super().__init__()
        self.access_token = access_token
        self.current_symbol = None
        self.preferences = self.load_preferences()
        self.power_status_lbl = None
        
        self.current_lod = 0.0
        self.current_hod = 0.0
        self.current_last_price = 0.0
        self.purchasing_power = 0.00 

        self.init_ui()
        
        history = self.preferences.get("symbol_history", [])
        self.ticker_combobox.addItems(history)
        
        last_sym = self.preferences.get("last_symbol", "")
        if last_sym:
            self.ticker_combobox.setCurrentText(last_sym)
            QtCore.QTimer.singleShot(100, self.fetch_active_symbol)

    def load_preferences(self):
        if os.path.exists(PREFS_FILE):
            try:
                with open(PREFS_FILE, 'r') as f:
                    prefs = json.load(f)
                    if "symbol_history" not in prefs: prefs["symbol_history"] = []
                    return prefs
            except Exception: pass
        return {"last_symbol": "", "risk_amount": "100", "symbol_history": []}

    def save_preferences(self):
        with open(PREFS_FILE, 'w') as f:
            json.dump(self.preferences, f)

    def refresh_account_balance(self):
        self.bal_worker = AccountBalanceWorker(self.access_token)
        self.bal_worker.balance_ready.connect(self.handle_balance_sync)
        self.bal_worker.start()

    def handle_balance_sync(self, live_power):
        self.purchasing_power = live_power
        main_window = self.window()
        if main_window and hasattr(main_window, 'statusBar'):
            status_bar = main_window.statusBar()
            existing_lbl = status_bar.findChild(QLabel, "power_status_indicator")
            
            if existing_lbl:
                self.power_status_lbl = existing_lbl
            elif self.power_status_lbl is None:
                self.power_status_lbl = QLabel()
                self.power_status_lbl.setObjectName("power_status_indicator")
                self.power_status_lbl.setStyleSheet("color: #00ff00; font-family: monospace; font-weight: bold; padding-left: 10px;")
                status_bar.addPermanentWidget(self.power_status_lbl, 1)
                status_bar.setStyleSheet("background-color: #1a1a1a; border-top: 1px solid #333333;")
            
            if self.power_status_lbl:
                self.power_status_lbl.setText(f"Available Power: ${live_power:,.2f}")
        
        self.calculate_share_allocation()

    def init_ui(self):
        outer_layout = QVBoxLayout(self)
        outer_layout.setContentsMargins(10, 10, 10, 10)

        top_ribbon = QHBoxLayout()
        self.ticker_combobox = QComboBox()
        self.ticker_combobox.setEditable(True)
        self.ticker_combobox.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.ticker_combobox.lineEdit().setPlaceholderText("Enter Ticker (AAPL, TSLA)")
        self.ticker_combobox.setMinimumWidth(150)
        self.ticker_combobox.lineEdit().returnPressed.connect(self.fetch_active_symbol)
        
        self.ticker_combobox.view().setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.ticker_combobox.view().customContextMenuRequested.connect(self.show_dropdown_context_menu)
        
        search_btn = QPushButton("Get Quote")
        search_btn.clicked.connect(self.fetch_active_symbol)
        
        top_ribbon.addWidget(self.ticker_combobox)
        top_ribbon.addWidget(search_btn)
        top_ribbon.addSpacing(30)

        top_ribbon.addWidget(QLabel("Risk ($):"))
        self.risk_input = QLineEdit()
        self.risk_input.setFixedWidth(90)
        self.risk_input.setValidator(QIntValidator(1, 1000000))
        self.risk_input.setText(self.preferences.get("risk_amount", "100"))
        self.risk_input.textChanged.connect(self.handle_risk_change)
        
        self.risk_input.setStyleSheet("""
            QLineEdit { background-color: #000000; color: #00ff00; font-family: 'Courier New', monospace;
                        font-size: 14px; font-weight: bold; border: 1px solid #333333; border-radius: 3px; padding: 3px; }
        """)
        top_ribbon.addWidget(self.risk_input)
        top_ribbon.addStretch()
        outer_layout.addLayout(top_ribbon)

        grid = QGridLayout()
        grid.setSpacing(10)
        
        self.panel_tl = QFrame()
        self.panel_tl.setStyleSheet("background-color: #222222; border-radius: 4px;")
        tl_layout = QVBoxLayout(self.panel_tl)
        self.sym_lbl = QLabel("NO SYMBOL")
        self.sym_lbl.setStyleSheet("font-size: 20px; font-weight: bold; color: #ffffff;")
        self.last_lbl = QLabel("$0.00")
        self.last_lbl.setStyleSheet("font-size: 18px; color: #b1b1b1;")
        tl_layout.addWidget(self.sym_lbl)
        tl_layout.addWidget(self.last_lbl)
        tl_layout.addStretch()
        grid.addWidget(self.panel_tl, 0, 0)

        self.chart_container = QFrame()
        self.chart_container.setStyleSheet("background-color: #1c1c1c; border-radius: 4px;")
        chart_layout = QVBoxLayout(self.chart_container)
        chart_layout.setContentsMargins(0, 0, 0, 0)
        
        self.chart_widget = pg.GraphicsLayoutWidget()
        chart_layout.addWidget(self.chart_widget)
        
        self.price_plot = self.chart_widget.addPlot(row=0, col=0)
        self.price_plot.setLabel('left', "Price")
        self.price_plot.showGrid(x=True, y=True, alpha=0.2)
        
        self.chart_widget.nextRow()
        self.vol_plot = self.chart_widget.addPlot(row=1, col=0)
        self.vol_plot.setLabel('left', "Vol")
        self.vol_plot.setMaximumHeight(65)
        self.vol_plot.showGrid(y=True, alpha=0.1)
        self.vol_plot.setXLink(self.price_plot)
        grid.addWidget(self.chart_container, 0, 1)

        self.panel_bl = QFrame()
        self.panel_bl.setStyleSheet("background-color: #222222; border-radius: 4px;")
        self.setup_execution_panel() 
        grid.addWidget(self.panel_bl, 1, 0)

        self.panel_br = QFrame()
        self.panel_br.setStyleSheet("background-color: #222222; border-radius: 4px;")
        grid.addWidget(self.panel_br, 1, 1)

        grid.setColumnStretch(0, 1); grid.setColumnStretch(1, 1)
        grid.setRowStretch(0, 1); grid.setRowStretch(1, 1)
        outer_layout.addLayout(grid)

    def show_dropdown_context_menu(self, pos):
        index = self.ticker_combobox.view().indexAt(pos)
        if not index.isValid(): return
        row = index.row()
        symbol_to_remove = self.ticker_combobox.itemText(row)
        
        menu = QMenu(self)
        remove_action = menu.addAction(f"Remove '{symbol_to_remove}' from History")
        
        action = menu.exec(self.ticker_combobox.view().mapToGlobal(pos))
        if action == remove_action:
            self.ticker_combobox.removeItem(row)
            if symbol_to_remove in self.preferences["symbol_history"]:
                self.preferences["symbol_history"].remove(symbol_to_remove)
            if self.ticker_combobox.currentText() == symbol_to_remove:
                self.ticker_combobox.setCurrentText("")
                self.preferences["last_symbol"] = ""
            self.save_preferences()

    def setup_execution_panel(self):
        bl_layout = QVBoxLayout(self.panel_bl)
        bl_layout.setContentsMargins(15, 15, 15, 15)
        bl_layout.setSpacing(10)

        panel_title = QLabel("ORDER EXECUTION PANEL")
        panel_title.setStyleSheet("font-size: 13px; font-weight: bold; color: #888888;")
        bl_layout.addWidget(panel_title)

        label_style = "color: #888888; font-weight: bold;"
        float_validator = QDoubleValidator(0.01, 999999.99, 2)
        float_validator.setNotation(QDoubleValidator.Notation.StandardNotation)

        input_style = """
            QLineEdit { background-color: #000000; color: lightgray; border: 1px solid #333333; border-radius: 3px; padding: 3px; }
            QLineEdit:disabled { background-color: #111111; color: #555555; }
        """

        limit_layout = QHBoxLayout()
        lbl_limit = QLabel("Limit Sell Price:")
        lbl_limit.setStyleSheet(label_style)
        limit_layout.addWidget(lbl_limit)
        
        self.limit_input = QLineEdit()
        self.limit_input.setValidator(float_validator)
        self.limit_input.setEnabled(False)
        self.limit_input.setStyleSheet(input_style)
        self.limit_input.textChanged.connect(self.calculate_share_allocation)
        limit_layout.addWidget(self.limit_input)

        self.hod_btn = QPushButton("HOD")
        self.hod_btn.setFixedWidth(45)
        self.hod_btn.clicked.connect(self.macro_fill_hod)
        limit_layout.addWidget(self.hod_btn)

        self.mult_1_btn = QPushButton("1")
        self.mult_1_btn.setFixedWidth(30)
        self.mult_1_btn.clicked.connect(lambda: self.apply_risk_multiplier(1.0))
        self.mult_15_btn = QPushButton("1.5")
        self.mult_15_btn.setFixedWidth(35)
        self.mult_15_btn.clicked.connect(lambda: self.apply_risk_multiplier(1.5))
        self.mult_2_btn = QPushButton("2")
        self.mult_2_btn.setFixedWidth(30)
        self.mult_2_btn.clicked.connect(lambda: self.apply_risk_multiplier(2.0))
        
        limit_layout.addWidget(self.mult_1_btn)
        limit_layout.addWidget(self.mult_15_btn)
        limit_layout.addWidget(self.mult_2_btn)
        bl_layout.addLayout(limit_layout)

        entry_layout = QHBoxLayout()
        lbl_entry = QLabel("Entry Price:")
        lbl_entry.setStyleSheet(label_style)
        entry_layout.addWidget(lbl_entry)
        
        self.stop_sign_btn = QPushButton("🛑")
        self.stop_sign_btn.setCheckable(True)
        self.stop_sign_btn.setFixedWidth(32)
        # Explicitly style the default (off) state and the checked (on) state
        self.stop_sign_btn.setStyleSheet("""
            QPushButton {
                background-color: #555555;  /* Greyed out when off */
                border: 1px solid #333333;
                border-radius: 3px;
            }
            QPushButton:checked {
                background-color: #ff3d00;  /* Bright red when toggled on */
                border: 1px solid #ff6d00;
            }
        """)
        entry_layout.addWidget(self.stop_sign_btn)

        self.entry_input = QLineEdit()
        self.entry_input.setValidator(float_validator)
        self.entry_input.setEnabled(False)
        self.entry_input.setStyleSheet(input_style)
        self.entry_input.textChanged.connect(self.calculate_share_allocation)
        entry_layout.addWidget(self.entry_input)
        
        self.hod_plus_btn = QPushButton("HOD+")
        self.hod_plus_btn.setFixedWidth(45)
        self.hod_plus_btn.clicked.connect(lambda: None)
        entry_layout.addWidget(self.hod_plus_btn)
        
        entry_spacer = QLabel("")
        entry_spacer.setFixedWidth(110)
        entry_layout.addWidget(entry_spacer)
        bl_layout.addLayout(entry_layout)

        stop_layout = QHBoxLayout()
        lbl_stop = QLabel("Stop Loss Price:")
        lbl_stop.setStyleSheet(label_style)
        stop_layout.addWidget(lbl_stop)
        
        self.stop_input = QLineEdit()
        self.stop_input.setValidator(float_validator)
        self.stop_input.setEnabled(False)
        self.stop_input.setStyleSheet(input_style)
        self.stop_input.textChanged.connect(self.calculate_share_allocation)
        
        self.lod_btn = QPushButton("LOD")
        self.lod_btn.setFixedWidth(45)
        self.lod_btn.clicked.connect(self.macro_fill_lod)
        
        stop_spacer = QLabel("")
        stop_spacer.setFixedWidth(110)
        
        stop_layout.addWidget(self.stop_input)
        stop_layout.addWidget(self.lod_btn)
        stop_layout.addWidget(stop_spacer)
        bl_layout.addLayout(stop_layout)

        allocation_layout = QHBoxLayout()
        lbl_shares = QLabel("Calculated Shares:")
        lbl_shares.setStyleSheet(label_style)
        allocation_layout.addWidget(lbl_shares)
        
        self.shares_output = QLineEdit()
        self.shares_output.setReadOnly(True)
        self.shares_output.setPlaceholderText("0")
        self.shares_output.setStyleSheet("background-color: #111111; color: #00ff00; font-weight: bold;")
        allocation_layout.addWidget(self.shares_output)
        bl_layout.addLayout(allocation_layout)

        action_layout = QHBoxLayout()
        self.btn_buy = QPushButton("BUY")
        self.btn_buy.setCheckable(True)
        self.btn_buy.setStyleSheet("QPushButton:checked { background-color: #00c853; color: white; font-weight: bold; }")
        self.btn_buy.clicked.connect(lambda: self.toggle_execution_side("BUY"))

        self.btn_sell = QPushButton("SELL")
        self.btn_sell.setCheckable(True)
        self.btn_sell.setStyleSheet("QPushButton:checked { background-color: #ff3d00; color: white; font-weight: bold; }")
        self.btn_sell.clicked.connect(lambda: self.toggle_execution_side("SELL"))

        action_layout.addWidget(self.btn_buy)
        action_layout.addWidget(self.btn_sell)
        bl_layout.addLayout(action_layout)
        
        self.btn_create_oco = QPushButton("CREATE OCO")
        self.btn_create_oco.setStyleSheet("background-color: #29b6f6; color: black; font-weight: bold; padding: 6px;")
        self.btn_create_oco.clicked.connect(self.execute_oco_order)
        bl_layout.addWidget(self.btn_create_oco)
        
        bl_layout.addStretch()

    def toggle_execution_side(self, side_selected):
        if side_selected == "BUY":
            self.btn_sell.setChecked(False)
            is_active = self.btn_buy.isChecked()
            for inp in [self.limit_input, self.entry_input, self.stop_input]: inp.setEnabled(is_active)
        else:
            self.btn_buy.setChecked(False)
            for inp in [self.limit_input, self.entry_input, self.stop_input]: inp.setEnabled(False)
            self.shares_output.clear()

        if not self.btn_buy.isChecked(): self.shares_output.clear()
        else: self.calculate_share_allocation()

    def macro_fill_hod(self):
        if self.current_hod > 0: self.limit_input.setText(f"{self.current_hod:.2f}")

    def macro_fill_lod(self):
        if self.current_lod > 0: self.stop_input.setText(f"{self.current_lod:.2f}")

    def execute_oco_order(self):
        if not self.btn_buy.isChecked():
            QMessageBox.warning(self, "Execution Error", "You must toggle 'BUY' to structuralize an order track.")
            return

        try:
            symbol = self.current_symbol
            shares = self.shares_output.text()
            entry_price = self.entry_input.text()
            profit_target = self.limit_input.text()
            stop_loss = self.stop_input.text()

            if not symbol or shares == "0" or not entry_price or not profit_target or not stop_loss:
                QMessageBox.warning(self, "Execution Error", "Missing critical front-end parameters.")
                return

            account_id = os.getenv("TRADESTATION_ACCOUNT_ID")

            # --- DYNAMIC ENTRY TYPE LOGIC BASED ON STOP SIGN TOGGLE ---
            if self.stop_sign_btn.isChecked():
                entry_type = "StopMarket"
                price_key = "StopPrice"
            else:
                entry_type = "Limit"
                price_key = "LimitPrice"

            # TradeStation v3 REST API nested Group Order Payload Architecture

            payload={
              "Type": "OSO",
                
              "AccountID": "11281048",
              "Symbol": "MO",
              "Quantity": "327",
              "OrderType": "Limit",
              "TradeAction": "BUY",
              "LimitPrice": "74.21",
              "Route": "Intelligent",
              "TimeInForce": {
                 "Duration": "DAY"
               },
               "Orders": [
                {
                  "AccountID": "11281048",
                  "Symbol": "MO",
                  "Quantity": "327",
                  "OrderType": "Limit",
                  "TradeAction": "SELL",
                  "LimitPrice": "75.28",
                  "Route": "Intelligent",
                  "TimeInForce": {
                    "Duration": "DAY"
                  }
                },
                {
                  "AccountID": "11281048",
                  "Symbol": "MO",
                  "Quantity": "327",
                  "OrderType": "StopMarket",
                  "TradeAction": "SELL",
                  "StopPrice": "73.60",
                  "Route": "Intelligent",
                  "TimeInForce": {
                    "Duration": "DAY"
                  }
                }
              ]
            }
#           payload = {
#              #"Type": "OSO",
#            #  "GroupOrderType": "OSO",
#               "AdvancedOptions": "OCO",

#               "Orders": [
#                   {
#                       "AccountID": account_id,
#                       "Symbol": symbol,
#                       "Quantity": shares,
#                       "OrderType": entry_type,      # Dynamic: "StopMarket" or "Limit"
#                       "TradeAction": "BUY",
#                       price_key: entry_price,        # Dynamic: "StopPrice" or "LimitPrice"
#                       "Route": "Intelligent",
#                       "TimeInForce": {"Duration": "DAY"}
#                   },
#                   {
#                       "GroupOrderType": "OCO",
#                       "AccountID": account_id,
#                       "Symbol": symbol,
#                       "Quantity": shares,
#                       "OrderType": "Limit",
#                       "TradeAction": "SELL",
#                       "LimitPrice": profit_target,
#                       "Route": "Intelligent",
#                       "TimeInForce": {"Duration": "DAY"}
#                   },
#                   {
#                       #"Type": "OCO",
#                       "GroupOrderType": "OCO",
#                       "AccountID": account_id,
#                       "Symbol": symbol,
#                       "Quantity": shares,
#                       "OrderType": "StopMarket",
#                       "TradeAction": "SELL",
#                       "StopPrice": stop_loss,
#                       "Route": "Intelligent",
#                       "TimeInForce": {"Duration": "DAY"}
#                   }
#               ]
#           }

            # Dispatch routine via standard HTTP client session
            headers = {
                "Authorization": f"Bearer {self.access_token}",
                "Content-Type": "application/json"
            }
            url = "https://api.tradestation.com/v3/brokerage/orders/group"
            url = "https://api.tradestation.com/v3/orderexecution/ordergroups"
#           url = "https://api.tradestation.com/v3/ordermanagement/grouporders"
            url = "https://api.tradestation.com/v3/orderexecution/orders"

            
            print(f"[*] Dispatching structured bracket order for {symbol} (Entry Type: {entry_type})...")
            response = requests.post(url, json=payload, headers=headers, timeout=10)
            if response.status_code in [200, 201]:
                QMessageBox.information(self, "Order Status", f"Bracket Order Sent Successfully!\nResponse: {response.text}")
            else:
                QMessageBox.critical(self, "API Execution Failure", f"Error Code {response.status_code}:\n{response.text}")
                print("\n" + "="*50)
                print(f"DEBUG: Outbound URL: {url}")
                print(f"DEBUG: HTTP Status Code: {response.status_code}")
                print(f"DEBUG: Response Headers: {json.dumps(dict(response.headers), indent=2)}")
                print(f"DEBUG: Sent Payload: {json.dumps(payload, indent=2)}")
                try:
                    print(f"DEBUG: Raw Server Error Body: {response.text}")
                except Exception as e:
                    print(f"DEBUG: Could not read response text: {e}")

        except Exception as e:
            QMessageBox.critical(self, "System Error", f"Failed to execute order routine:\n{str(e)}")

    def apply_risk_multiplier(self, multiplier):
        try:
            entry_price = float(self.entry_input.text() if self.entry_input.text() else 0)
            stop_loss = float(self.stop_input.text() if self.stop_input.text() else 0)
            if entry_price > stop_loss > 0:
                self.limit_input.setText(f"{(entry_price + (multiplier * (entry_price - stop_loss))):.2f}")
        except ValueError: pass

    def calculate_share_allocation(self):
        if not self.btn_buy.isChecked(): return
        try:
            risk = float(self.risk_input.text() if self.risk_input.text() else 0)
            stop_loss = float(self.stop_input.text() if self.stop_input.text() else 0)
            entry_price = float(self.entry_input.text() if self.entry_input.text() else 0)

            if risk <= 0 or entry_price <= 0 or stop_loss <= 0 or stop_loss >= entry_price:
                self.shares_output.setText("0"); return

            target_shares = int(risk / (entry_price - stop_loss))
            max_affordable_shares = int(self.purchasing_power / entry_price)
            
            if target_shares > max_affordable_shares:
                final_shares = max_affordable_shares
                self.shares_output.setStyleSheet("background-color: #111111; color: #ff6d00; font-weight: bold;")
            else:
                final_shares = target_shares
                self.shares_output.setStyleSheet("background-color: #111111; color: #00ff00; font-weight: bold;")

            self.shares_output.setText(str(max(0, final_shares)))
        except ValueError: self.shares_output.setText("0")

    def handle_risk_change(self, text):
        self.preferences["risk_amount"] = text
        self.save_preferences()
        self.calculate_share_allocation()

    def fetch_active_symbol(self):
        symbol = self.ticker_combobox.currentText().strip().upper()
        if not symbol: return
        
        self.current_symbol = symbol
        self.sym_lbl.setText(f"Loading {symbol}...")

        if "symbol_history" not in self.preferences: self.preferences["symbol_history"] = []
        if symbol in self.preferences["symbol_history"]: self.preferences["symbol_history"].remove(symbol)
        self.preferences["symbol_history"].insert(0, symbol)
        self.preferences["last_symbol"] = symbol
        
        self.ticker_combobox.blockSignals(True)
        self.ticker_combobox.clear()
        self.ticker_combobox.addItems(self.preferences["symbol_history"])
        self.ticker_combobox.setCurrentText(symbol)
        self.ticker_combobox.blockSignals(False)
        
        self.save_preferences()
        self.refresh_account_balance()

        self.data_worker = ChartDataWorker(self.access_token, symbol)
        self.data_worker.data_ready.connect(self.plot_historical_data)
        self.data_worker.error_signal.connect(lambda err: self.sym_lbl.setText("ERROR"))
        self.data_worker.start()

    def plot_historical_data(self, df, prev_high, prev_low, true_hod, true_lod):
        self.sym_lbl.setText(self.current_symbol)
        self.current_last_price = float(df.iloc[-1]['Close'])
        self.current_hod = true_hod
        self.current_lod = true_lod
        self.last_lbl.setText(f"${self.current_last_price:,.2f}")

        if self.current_last_price > 0 and (not self.entry_input.hasFocus() or not self.entry_input.text()):
            self.entry_input.setText(f"{self.current_last_price:.2f}")

        if self.current_lod > 0 and (not self.stop_input.hasFocus() or not self.stop_input.text()):
            self.stop_input.setText(f"{self.current_lod:.2f}")

        self.price_plot.clear(); self.vol_plot.clear()

        if prev_high > 0:
            self.price_plot.addItem(pg.InfiniteLine(angle=0, pos=prev_high, pen=pg.mkPen('#00796b', width=1, style=QtCore.Qt.PenStyle.DashDotLine)))
            self.price_plot.addItem(pg.InfiniteLine(angle=0, pos=prev_low, pen=pg.mkPen('#bf360c', width=1, style=QtCore.Qt.PenStyle.DashDotLine)))

        self.price_plot.addItem(CandlestickItem((df.index.values, df['Open'].values, df['Close'].values, df['Low'].values, df['High'].values)))
        self.price_plot.plot(df.index.values, df['VWAP'].values, pen=pg.mkPen(color='#2196f3', width=1.5, style=QtCore.Qt.PenStyle.DotLine))

        bar_colors = np.where(df['Close'] >= df['Open'], '#00c85380', '#ff3d0080')
        self.vol_plot.addItem(pg.BarGraphItem(x=df.index.values, height=df['Volume'].values, width=0.7, brushes=bar_colors, pens=bar_colors))

        self.price_plot.autoRange(); self.vol_plot.autoRange()
        self.calculate_share_allocation()
