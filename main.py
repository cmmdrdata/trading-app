import sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QStackedWidget, QLabel
from PyQt6.QtCore import QTimer

# Import structural layout classes from secondary files
from ui_screens import LoginScreen, DashboardScreen

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("TradeStation Risk Terminal")
        self.resize(1200, 800)

        self.power_status_lbl = QLabel("Available Power: $0.00")
        self.power_status_lbl.setStyleSheet("color: #00ff00; font-family: monospace; font-weight: bold; padding-left: 10px;")
        
        self.statusBar().addPermanentWidget(self.power_status_lbl, 1)
        self.statusBar().setStyleSheet("background-color: #1a1a1a; border-top: 1px solid #333333;")

        self.stacked = QStackedWidget()
        self.setCentralWidget(self.stacked)

        self.login = LoginScreen(on_login_callback=self.activate_dashboard)
        self.stacked.addWidget(self.login)
        
        QTimer.singleShot(100, self.login.start_auth_flow)

    def activate_dashboard(self, token):
        self.dashboard = DashboardScreen(token)
        self.stacked.addWidget(self.dashboard)
        self.stacked.setCurrentWidget(self.dashboard)

if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
