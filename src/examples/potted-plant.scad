// A potted plant. Drag the numbers, or edit freely.

// Saucer outer diameter
saucer_diameter = 46;     // [30:2:70]
// Saucer height
saucer_height = 5;        // [4:1:16]
// Saucer base floor thickness
saucer_floor = 3;         // [1.5:0.5:6]
// Saucer wall thickness
saucer_wall = 2.5;        // [1.5:0.5:5]
// Pot height
pot_height = 40;          // [25:5:70]
// Pot maximum diameter
pot_diameter = 50;        // [30:5:80]
// Pot base diameter
pot_base_dia = 32;        // [20:2:50]
// Pot wall thickness
pot_wall = 3;             // [2:0.5:6]
// Soil recess below rim
soil_recess = 4;          // [2:1:8]
// Stem total height
stem_height = 70;         // [40:5:120]
// Stem base diameter
stem_diameter = 8;        // [5:1:14]
// Leaf length
leaf_length = 50;         // [30:5:80]
// Leaf width
leaf_width = 22;          // [12:2:40]
// Leaf thickness
leaf_thickness = 2.2;     // [1.5:0.2:4]

$fn = 48;

// Function for natural stem curve
function stem_pos(t) = [
  sin(t * 180) * 8 + sin(t * 360) * 2,
  cos(t * 140) * 4 - 4,
  t * stem_height
];

// Saucer / drip tray resting below the pot
module saucer() {
  bottom_dia = saucer_diameter * 0.82;
  inner_bottom_dia = bottom_dia - (2 * saucer_wall);
  inner_top_dia = saucer_diameter - (2 * saucer_wall);

  difference() {
    // Outer dish body with rounded bottom chamfer
    hull() {
      translate([0, 0, 1])
        cylinder(h = saucer_height - 1, d1 = bottom_dia, d2 = saucer_diameter);
      cylinder(h = 1, d1 = bottom_dia - 2, d2 = bottom_dia);
    }

    // Dish interior cavity
    translate([0, 0, saucer_floor])
      cylinder(h = saucer_height - saucer_floor + 1, d1 = inner_bottom_dia, d2 = inner_top_dia);
  }
}

// Planter pot with distinct hollow rim
module pot() {
  rim_dia = pot_diameter * 0.78;
  inner_rim_dia = rim_dia - (2 * pot_wall);

  difference() {
    union() {
      // Outer shell
      rotate_extrude() {
        hull() {
          square([pot_base_dia / 2, 2]);
          translate([0, pot_height * 0.42]) square([pot_diameter / 2, 2]);
          translate([0, pot_height - 5]) square([rim_dia / 2, 5]);
        }
      }
      // Top lip / rim collar
      translate([0, 0, pot_height - 5])
        cylinder(h = 5, d1 = rim_dia, d2 = rim_dia + 2);
    }

    // Upper interior hollow down to soil line
    translate([0, 0, pot_height - soil_recess])
      cylinder(h = soil_recess + 2, d = inner_rim_dia);
  }
}

// Distinct textured soil bed filling the pot recess
module soil() {
  rim_dia = pot_diameter * 0.78;
  soil_dia = rim_dia - (2 * pot_wall) + 0.8;
  soil_top_z = pot_height - soil_recess;

  union() {
    // Soil plug anchoring into pot body
    translate([0, 0, soil_top_z - 6])
      cylinder(h = 6, d = soil_dia);

    // Mounded soil surface dome
    translate([0, 0, soil_top_z - 2])
      scale([1, 1, 0.35])
        sphere(d = soil_dia);

    // Organic soil clods and pebble texture on surface
    for (a = [0 : 45 : 315]) {
      rad = (soil_dia * 0.30) * (0.6 + 0.4 * sin(a * 3));
      translate([cos(a) * rad, sin(a) * rad, soil_top_z - 0.5 + sin(a * 2) * 0.6])
        rotate([sin(a * 4) * 15, cos(a * 3) * 15, a])
          scale([1.2, 0.9, 0.6])
            sphere(d = 4.5);
    }
    for (a = [22 : 60 : 340]) {
      rad = (soil_dia * 0.18);
      translate([cos(a) * rad, sin(a) * rad, soil_top_z + 0.2])
        sphere(d = 3.5);
    }
  }
}

// Organic curved stem
module natural_stem() {
  steps = 24;
  for (i = [0 : steps - 1]) {
    t1 = i / steps;
    t2 = (i + 1) / steps;
    p1 = stem_pos(t1);
    p2 = stem_pos(t2);
    d1 = stem_diameter * (1 - 0.45 * t1);
    d2 = stem_diameter * (1 - 0.45 * t2);

    hull() {
      translate(p1) sphere(d = d1);
      translate(p2) sphere(d = d2);
    }
  }
}

// Individual arched leaf blade
module single_leaf(len, width, thick) {
  steps = 14;
  for (i = [0 : steps - 1]) {
    t1 = i / steps;
    t2 = (i + 1) / steps;

    x1 = t1 * len;
    z1 = sin(t1 * 130) * (len * 0.42);
    x2 = t2 * len;
    z2 = sin(t2 * 130) * (len * 0.42);

    w1 = sin(t1 * 180) * width + 1.2;
    w2 = sin(t2 * 180) * width + 0.8;
    th1 = (1 - 0.4 * t1) * thick;
    th2 = (1 - 0.4 * t2) * thick;

    hull() {
      translate([x1, 0, z1])
        scale([1, w1 / 2, th1 / 2])
          sphere(r = 1);
      translate([x2, 0, z2])
        scale([1, w2 / 2, th2 / 2])
          sphere(r = 1);
    }
  }
}

// Foliage head composed of exactly 3 natural leaves
module foliage_three_leaves() {
  top_pos = stem_pos(1.0);

  leaf_configs = [
    // [rot_z, pitch_angle, roll_angle, scale_factor, height_offset]
    [  15, 32, -10, 1.00,  0.0],
    [ 135, 38,  12, 0.90, -4.0],
    [ 255, 30,  -8, 0.80, -8.0]
  ];

  for (cfg = leaf_configs) {
    rot_z = cfg[0];
    pitch = cfg[1];
    roll  = cfg[2];
    s     = cfg[3];
    z_off = cfg[4];

    translate([top_pos[0], top_pos[1], top_pos[2] + z_off])
      rotate([0, 0, rot_z])
        rotate([roll, pitch, 0])
          scale([s, s, s])
            single_leaf(leaf_length, leaf_width, leaf_thickness);
  }

  // Central apex bud
  translate(top_pos)
    sphere(d = stem_diameter * 0.55);
}

// Complete potted plant assembly with bottom tray
module potted_plant_with_saucer() {
  union() {
    // Saucer sitting flat on Z=0
    color("Sienna") saucer();

    // Pot, soil, and plant positioned securely inside the saucer
    translate([0, 0, saucer_floor - 0.2]) {
      color("Peru") pot();
      color("SaddleBrown") soil();
      translate([0, 0, pot_height - soil_recess - 1]) {
        color("OliveDrab") natural_stem();
        color("ForestGreen") foliage_three_leaves();
      }
    }
  }
}

// ---- PART 1 ----
potted_plant_with_saucer();
// ---- PART 1 END ----
