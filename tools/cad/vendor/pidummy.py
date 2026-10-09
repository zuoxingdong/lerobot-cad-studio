"""Raspberry Pi 5 dummy in ROBOT coordinates for rev E.
Board frame (from the stock case, board.py/walls2.py):
  Xc = microSD edge -> IO edge (85), Yc = HDMI edge -> GPIO edge (56), Zc = solder -> component.
rev E pose:  Xc -> +Zr,  Yc -> -Xr,  Zc -> -Yr   (right-handed, det=+1)
So the HDMI/USB-C long edge faces +X, the IO short edge faces +Z, microSD faces -Z."""
import numpy as np, trimesh
TX,TY,TZ = 0.0,-59.5,106.5
def to_robot(xc,yc,zc): return np.array([-yc+TX, -zc+TY, xc+TZ])
def blk(xc,yc,zc,dxc,dyc,dzc):
    lo=to_robot(xc,yc,zc); hi=to_robot(xc+dxc,yc+dyc,zc+dzc)
    a=np.minimum(lo,hi); b=np.maximum(lo,hi)
    return trimesh.creation.box(extents=b-a, transform=trimesh.transformations.translation_matrix((a+b)/2))
PCB   = blk(-42.5,-28.0,0.0, 85.0,56.0,1.6)
USBC  = blk(-36.1,-29.5,1.6,  9.6, 8.0,3.2)      # on the Yc=-28 edge, protruding 1.5
HDMI0 = blk(-19.9,-29.5,1.6,  6.6, 8.0,3.0)
HDMI1 = blk( -6.7,-29.5,1.6,  7.2, 8.0,3.0)
IO    = blk( 41.0,-25.9,1.6, 12.0,51.6,13.5)     # Ethernet + 2 USB-A stacks, overhanging the edge
SD    = blk(-44.0, -6.1,-1.0, 3.0,12.0,2.6)      # microSD, protruding below the board edge
SDOUT = blk(-57.5, -6.1,-1.0,16.5,12.0,2.6)      # the card fully withdrawn (15 mm of travel)
PARTS={'PCB':PCB,'USB-C':USBC,'HDMI0':HDMI0,'HDMI1':HDMI1,'IO(eth+usb)':IO,'microSD':SD,'SD withdrawn':SDOUT}
if __name__=='__main__':
    for k,v in PARTS.items():
        b=v.bounds
        print("  %-13s X %7.2f..%7.2f  Y %7.2f..%7.2f  Z %7.2f..%7.2f"%(k,b[0][0],b[1][0],b[0][1],b[1][1],b[0][2],b[1][2]))
