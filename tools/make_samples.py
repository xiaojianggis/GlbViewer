"""Generates the synthetic sample files in samples/.

street-canyon.plt  Tecplot ASCII: ground grid + building blocks with a made-up
                   UTCI / MRT field (illustrative only, not a simulation).
scan-cloud.ply     ASCII PLY point cloud (terrain + trees) with RGB and a
                   per-point "height_above_ground" scalar.
"""
import math, os, random, struct

OUT = os.path.join(os.path.dirname(__file__), "..", "samples")
os.makedirs(OUT, exist_ok=True)
random.seed(7)

# ---------------------------------------------------------------- Tecplot
BUILDINGS = [  # x0, y0, x1, y1, height
    (30, 20, 70, 55, 42), (95, 15, 125, 60, 24), (150, 25, 185, 70, 60),
    (30, 85, 80, 130, 30), (105, 90, 140, 135, 18), (160, 95, 190, 140, 36),
]
SUN = (-0.55, -0.45, 0.70)  # direction towards the sun (from SE, fairly high)


def shadow(x, y):
    """1 if the ground point is shaded by a building."""
    for x0, y0, x1, y1, h in BUILDINGS:
        # march towards the sun
        for s in range(1, 80):
            t = s * 1.5
            px, py, pz = x + SUN[0] * t, y + SUN[1] * t, SUN[2] * t
            if x0 <= px <= x1 and y0 <= py <= y1 and pz <= h:
                return 1.0
            if pz > h:
                break
    return 0.0


def inside(x, y):
    return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1, _ in BUILDINGS)


TREES = [(88, 75), (95, 75), (102, 75), (145, 78), (20, 70), (200, 80), (60, 140), (90, 145)]


def utci_ground(x, y):
    sh = shadow(x, y)
    tree = sum(math.exp(-((x - tx) ** 2 + (y - ty) ** 2) / 60) for tx, ty in TREES)
    near = min((min(abs(x - x0), abs(x - x1)) + min(abs(y - y0), abs(y - y1))) for x0, y0, x1, y1, _ in BUILDINGS)
    mrt = 64 - 22 * sh - 18 * min(tree, 1) + 4 * math.exp(-near / 8)
    utci = 30.5 + 0.38 * (mrt - 31) + 0.6 * math.sin(x / 23) + 0.4 * math.cos(y / 17)
    return utci, mrt


lines = ['TITLE = "Synthetic street canyon (illustrative, not simulation output)"',
         'VARIABLES = "X" "Y" "Z" "UTCI [degC]" "MRT [degC]"']

I, J = 89, 67
xs = [i * 2.5 for i in range(I)]
ys = [j * 2.5 for j in range(J)]
lines.append(f'ZONE T="Ground", I={I}, J={J}, K=1, DATAPACKING=BLOCK')
grid = [(x, y) for y in ys for x in xs]
vals = [utci_ground(x, y) for x, y in grid]
cols = [[x for x, _ in grid], [y for _, y in grid], [0.0] * len(grid),
        [v[0] for v in vals], [v[1] for v in vals]]
for col in cols:
    for k in range(0, len(col), 10):
        lines.append(" ".join(f"{v:.4g}" for v in col[k:k + 10]))

for b, (x0, y0, x1, y1, h) in enumerate(BUILDINGS):
    bi, bj, bk = 9, 9, max(4, int(h / 3))
    lines.append(f'ZONE T="Building {b + 1}", I={bi}, J={bj}, K={bk}, DATAPACKING=POINT')
    for k in range(bk):
        z = h * k / (bk - 1)
        for j in range(bj):
            y = y0 + (y1 - y0) * j / (bj - 1)
            for i in range(bi):
                x = x0 + (x1 - x0) * i / (bi - 1)
                # facade facing the sun (south/east) is hotter; roof hottest
                facing = 0.0
                if j == 0: facing += 1.0
                if i == bi - 1: facing += 0.6
                if k == bk - 1: facing = 1.4
                mrt = 40 + 14 * facing + 3 * (z / 60)
                utci = 29 + 0.35 * (mrt - 31)
                lines.append(f"{x:.3f} {y:.3f} {z:.3f} {utci:.3f} {mrt:.3f}")

with open(os.path.join(OUT, "street-canyon.plt"), "w") as f:
    f.write("\n".join(lines) + "\n")

# ---------------------------------------------------------------- PLY cloud
pts = []
for _ in range(60_000):
    x, y = random.uniform(0, 120), random.uniform(0, 90)
    z = 3 * math.sin(x / 19) + 2 * math.cos(y / 13) + random.gauss(0, 0.05)
    g = 0.45 + 0.1 * math.sin(x / 7)
    pts.append((x, y, z, int(110 * g + 40), int(150 * g + 50), int(70 * g + 20), 0.0))
for _ in range(40):
    tx, ty = random.uniform(10, 110), random.uniform(10, 80)
    tz = 3 * math.sin(tx / 19) + 2 * math.cos(ty / 13)
    th, cr = random.uniform(6, 14), random.uniform(2.5, 5)
    for _ in range(1500):
        if random.random() < 0.12:  # trunk
            a = random.uniform(0, 2 * math.pi)
            px, py, pz = tx + 0.3 * math.cos(a), ty + 0.3 * math.sin(a), tz + random.uniform(0, th * 0.6)
            c = (95, 70, 50)
        else:
            u, v = random.uniform(-1, 1), random.uniform(0, 2 * math.pi)
            r = cr * random.uniform(0.8, 1.0)
            px = tx + r * math.sqrt(1 - u * u) * math.cos(v)
            py = ty + r * math.sqrt(1 - u * u) * math.sin(v)
            pz = tz + th * 0.6 + r * 0.8 * (u + 1)
            c = (int(random.uniform(40, 80)), int(random.uniform(100, 150)), int(random.uniform(40, 70)))
        pts.append((px, py, pz, *c, pz - tz))

header = (
    "ply\nformat ascii 1.0\ncomment synthetic terrain + trees\n"
    f"element vertex {len(pts)}\nproperty float x\nproperty float y\nproperty float z\n"
    "property uchar red\nproperty uchar green\nproperty uchar blue\n"
    "property float height_above_ground\nend_header\n"
)
with open(os.path.join(OUT, "scan-cloud.ply"), "w") as f:
    f.write(header)
    f.writelines(f"{p[0]:.3f} {p[1]:.3f} {p[2]:.3f} {p[3]} {p[4]} {p[5]} {p[6]:.2f}\n" for p in pts)
print("samples written to", os.path.abspath(OUT))
