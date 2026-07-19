import os
import json
import time
import requests
import pandas as pd
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from PyQt6.QtCore import QThread, pyqtSignal
from config import TOKEN_FILE

class AccountBalanceWorker(QThread):
    """Background thread to fetch live brokerage account liquidity metrics directly using local env ID"""
    balance_ready = pyqtSignal(float)
    error_signal = pyqtSignal(str)

    def __init__(self, access_token):
        super().__init__()
        self.access_token = access_token

    def run(self):
        try:
            account_id = os.getenv("TRADESTATION_ACCOUNT_ID")
            if not account_id:
                self.error_signal.emit("Missing TRADESTATION_ACCOUNT_ID in your .env file.")
                return

            headers = {"Authorization": f"Bearer {self.access_token}"}
            balances_url = f"https://api.tradestation.com/v3/brokerage/accounts/{account_id}/balances"
            bal_res = requests.get(balances_url, headers=headers, timeout=10)
            
            if bal_res.status_code != 200:
                self.error_signal.emit(f"Failed to fetch account balances. Code: {bal_res.status_code}")
                return
                
            bal_data = bal_res.json()
            balances_list = bal_data.get("Balances", [])
            
            if not balances_list:
                self.error_signal.emit("Balances array empty.")
                return
                
            account_balance = balances_list[0]
            buying_power = float(account_balance.get("BuyingPower", 
                                 account_balance.get("CashBalance", 0.0)))
            
            self.balance_ready.emit(buying_power)
        except Exception as e:
            self.error_signal.emit(str(e))


class TradeStationAuthWorker(QThread):
    """Handles automatic token refreshing OR falling back to the browser OAuth server"""
    auth_success = pyqtSignal(str)
    auth_failed = pyqtSignal(str)

    def run(self):
        client_id = os.getenv("TRADESTATION_CLIENT_ID")
        client_secret = os.getenv("TRADESTATION_CLIENT_SECRET")
        redirect_uri = os.getenv("TRADESTATION_REDIRECT_URI")

        if not client_id or not client_secret:
            self.auth_failed.emit("Missing .env configurations.")
            return

        if os.path.exists(TOKEN_FILE):
            try:
                with open(TOKEN_FILE, 'r') as f:
                    token_data = json.load(f)
                
                if "expires_at" in token_data:
                    expiry_time = time.strftime('%Y-%m-%d %I:%M:%S %p', time.localtime(token_data["expires_at"]))
                    print(f"==================================================")
                    print(f"[*] LAUNCH STATUS: Active token expires at: {expiry_time}")
                    print(f"==================================================")

                if token_data.get("expires_at", 0) > time.time() + 30:
                    self.auth_success.emit(token_data["access_token"])
                    return
                
                if "refresh_token" in token_data:
                    print("[*] Token expired. Attempting background refresh...")
                    refresh_url = "https://signin.tradestation.com/oauth/token"
                    payload = {
                        "grant_type": "refresh_token",
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "refresh_token": token_data["refresh_token"]
                    }
                    headers = {"content-type": "application/x-www-form-urlencoded"}
                    
                    response = requests.post(refresh_url, data=payload, headers=headers)
                    if response.status_code == 200:
                        new_token_data = response.json()
                        new_token_data["expires_at"] = time.time() + int(new_token_data.get("expires_in", 1200))
                        if "refresh_token" not in new_token_data:
                            new_token_data["refresh_token"] = token_data["refresh_token"]
                        with open(TOKEN_FILE, 'w') as f:
                            json.dump(new_token_data, f)
                        
                        new_expiry_time = time.strftime('%Y-%m-%d %I:%M:%S %p', time.localtime(new_token_data["expires_at"]))
                        print(f"[*] REFRESH SUCCESS: New token expires at: {new_expiry_time}")
                        
                        self.auth_success.emit(new_token_data["access_token"])
                        return
            except Exception as e:
                print(f"[!] Error reading/refreshing token file on launch: {e}")

        captured_code = []
        class CallbackHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                parsed_url = urllib.parse.urlparse(self.path)
                query_params = urllib.parse.parse_qs(parsed_url.query)
                if "code" in query_params:
                    captured_code.append(query_params["code"][0])
                    self.send_response(200); self.end_headers()
                    self.wfile.write(b"Auth Successful. Close this tab.")
                else:
                    self.send_response(400); self.end_headers()
            def log_message(self, format, *args): pass

        try:
            server = HTTPServer(("127.0.0.1", 3000), CallbackHandler)
            scopes = "openid offline_access profile MarketData ReadAccount Trade"
            auth_url = (
                f"https://signin.tradestation.com/authorize?response_type=code&"
                f"client_id={client_id}&redirect_uri={redirect_uri}&"
                f"audience=https://api.tradestation.com&scope={scopes}"
            )
            webbrowser.open(auth_url)
            server.handle_request()
            server.server_close()

            if not captured_code:
                self.auth_failed.emit("Failed to capture code."); return

            token_url = "https://signin.tradestation.com/oauth/token"
            payload = f"grant_type=authorization_code&client_id={client_id}&client_secret={client_secret}&code={captured_code[0]}&redirect_uri={redirect_uri}"
            headers = {"content-type": "application/x-www-form-urlencoded"}

            response = requests.post(token_url, data=payload, headers=headers)
            if response.status_code == 200:
                data = response.json()
                data["expires_at"] = time.time() + int(data.get("expires_in", 1200))
                with open(TOKEN_FILE, 'w') as f:
                    json.dump(data, f)
                self.auth_success.emit(data.get("access_token"))
            else:
                self.auth_failed.emit(f"Token Error: {response.text}")
        except Exception as e:
            self.auth_failed.emit(str(e))


class ChartDataWorker(QThread):
    """Background thread to fetch chart bars and track true daily High/Low boundaries"""
    data_ready = pyqtSignal(pd.DataFrame, float, float, float, float)
    error_signal = pyqtSignal(str)

    def __init__(self, access_token, symbol):
        super().__init__()
        self.access_token = access_token
        self.symbol = symbol.upper()

    def run(self):
        try:
            headers = {"Authorization": f"Bearer {self.access_token}"}
            
            url_intraday = f"https://api.tradestation.com/v3/marketdata/barcharts/{self.symbol}"
            params = {"interval": "1", "unit": "Minute", "barcount": "90"}
            
            res = requests.get(url_intraday, headers=headers, params=params)
            if res.status_code != 200:
                self.error_signal.emit(f"Intraday fetch failed: {res.status_code}"); return
                
            bars = res.json().get("Bars", [])
            if not bars:
                self.error_signal.emit(f"No bars found for {self.symbol}"); return
            
            df = pd.DataFrame(bars)
            df['Time'] = pd.to_datetime(df['TimeStamp'])
            for col in ['Open', 'Close', 'High', 'Low']:
                df[col] = df[col].astype(float)
            df['Volume'] = df['TotalVolume'].astype(int)

            df['Typical_Price'] = (df['High'] + df['Low'] + df['Close']) / 3
            df['TP_Vol'] = df['Typical_Price'] * df['Volume']
            df['VWAP'] = df['TP_Vol'].cumsum() / df['Volume'].cumsum()

            url_daily = f"https://api.tradestation.com/v3/marketdata/barcharts/{self.symbol}"
            params_daily = {"interval": "1", "unit": "Daily", "barcount": "2"}
            
            res_daily = requests.get(url_daily, headers=headers, params=params_daily)
            prev_high, prev_low = 0.0, 0.0
            true_hod, true_lod = 0.0, 0.0
            
            if res_daily.status_code == 200:
                daily_bars = res_daily.json().get("Bars", [])
                if len(daily_bars) >= 2:
                    prev_high = float(daily_bars[-2]['High'])
                    prev_low = float(daily_bars[-2]['Low'])
                if len(daily_bars) >= 1:
                    true_hod = float(daily_bars[-1]['High'])
                    true_lod = float(daily_bars[-1]['Low'])

            if true_hod == 0: true_hod = float(df['High'].max())
            if true_lod == 0: true_lod = float(df['Low'].min())

            self.data_ready.emit(df, prev_high, prev_low, true_hod, true_lod)
        except Exception as e:
            self.error_signal.emit(str(e))
