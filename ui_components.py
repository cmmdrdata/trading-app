import numpy as np
import pyqtgraph as pg
from pyqtgraph.Qt import QtCore, QtGui

class CandlestickItem(pg.GraphicsObject):
    """Custom component to draw highly optimized 1-minute candlesticks"""
    def __init__(self, data):
        super().__init__()
        self.data = data
        self.picture = QtGui.QPicture()
        self.generate_picture()

    def generate_picture(self):
        p = QtGui.QPainter(self.picture)
        w = 0.6
        for i, (time, open_p, close_p, low_p, high_p) in enumerate(zip(*self.data)):
            if open_p is None or np.isnan(open_p): continue
            if open_p < close_p:
                p.setPen(pg.mkPen('#00c853', width=1.5))
                p.setBrush(pg.mkBrush('#00c853'))
            else:
                p.setPen(pg.mkPen('#ff3d00', width=1.5))
                p.setBrush(pg.mkBrush('#ff3d00'))
            if high_p != low_p:
                p.drawLine(QtCore.QPointF(i, low_p), QtCore.QPointF(i, high_p))
            p.drawRect(QtCore.QRectF(i - w/2.0, open_p, w, close_p - open_p))
        p.end()

    def paint(self, p, *args): 
        p.drawPicture(0, 0, self.picture)
        
    def boundingRect(self): 
        return QtCore.QRectF(self.picture.boundingRect())
