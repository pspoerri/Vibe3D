// A Biergarten sign

// Overall sign width
sign_width = 210;    // [140:10:300]
// Overall sign height
sign_height = 100;   // [70:5:160]
// Base plate thickness
base_thick = 3.0;    // [2.0:0.5:6.0]
// Raised lettering and trim relief height
relief_h = 1.4;      // [0.8:0.2:3.0]
// Beer mugs and foam 3D relief height (3x plate thickness)
beer_relief_h = 9.0; // [3.0:0.5:18.0]
// Main lettering text
main_text = "Biergarten";
// Subtitle text (leave empty for none)
sub_text = "WILLKOMMEN";
// Main text font size
text_size = 19;      // [12:1:32]
// Include beer steins motif
show_beers = true;
// Half-distance between beer steins from center
beer_spacing = 40;   // [20:1:50]
// Include mounting screw holes
mount_holes = true;
// Mounting hole diameter
hole_diam = 4.5;     // [3.0:0.5:8.0]
// Base plate color
color_base = "#1B432C";
// Trim, border, ornaments, and steins color
color_trim = "#D4AF37";
// Main lettering color
color_text = "#FFF8E7";
// Beer foam white color
color_foam = "#FFFFFF";

$fn = 48;

// Shared 3D dome resting on Z=0
module dome(r, h) {
  intersection() {
    scale([1, 1, h / r])
      sphere(r = r);
    translate([-r * 1.5, -r * 1.5, 0])
      cube([r * 3, r * 3, h * 2]);
  }
}

// 2D profile for the arched tavern sign plate
module sign_base_shape_2d(w, h, r_c) {
  offset(r = r_c) offset(delta = -r_c) {
    translate([0, -h * 0.08])
      square([w - 2 * r_c, h * 0.84], center = true);

    translate([0, h * 0.22])
      scale([1, 0.45])
        circle(d = w * 0.82);

    if (mount_holes) {
      translate([-w * 0.41, h * 0.18])
        circle(r = 13);
      translate([w * 0.41, h * 0.18])
        circle(r = 13);
    }
  }
}

// Raised decorative borders and screw hole bezels
module sign_borders_2d(w, h, r_c) {
  difference() {
    sign_base_shape_2d(w, h, r_c);
    offset(r = -2.5) sign_base_shape_2d(w, h, r_c);
  }
  difference() {
    offset(r = -4.5) sign_base_shape_2d(w, h, r_c);
    offset(r = -5.8) sign_base_shape_2d(w, h, r_c);
  }
  if (mount_holes) {
    for (sx = [-1, 1]) {
      translate([sx * w * 0.41, h * 0.18])
        difference() {
          circle(d = hole_diam + 5.0);
          circle(d = hole_diam);
        }
    }
  }
}

// Top arch flourish divider
module flourish_divider_2d(span = 68) {
  rotate([0, 0, 45])
    square([3.0, 3.0], center = true);
  for (sx = [-1, 1]) {
    scale([sx, 1]) {
      translate([span * 0.25 + 2, 0])
        square([span * 0.48, 0.9], center = true);
      translate([span * 0.5 + 2, 0])
        circle(r = 1.2);
    }
  }
}

// Top arch Bavarian diamonds and flourish
module top_ornaments_2d(h) {
  translate([0, h * 0.405])
    rotate([0, 0, 45])
      square([6.5, 6.5], center = true);
  for (sx = [-1, 1]) {
    translate([sx * 13, h * 0.38])
      rotate([0, 0, 45])
        square([4.8, 4.8], center = true);
    translate([sx * 24, h * 0.35])
      rotate([0, 0, 45])
        square([3.5, 3.5], center = true);
  }
  translate([0, h * 0.28])
    flourish_divider_2d(span = 68);
}

// Wheat stalk with plump symmetrical paired grains and curved stem
module wheat_stalk_2d(length = 33, grains = 6) {
  hull() {
    translate([0, -3]) circle(r = 0.8);
    translate([-1.2, length * 0.5]) circle(r = 0.6);
    translate([-2.2, length]) circle(r = 0.4);
  }

  for (i = [0 : grains - 1]) {
    t = (i + 0.5) / grains;
    y_pos = t * length;
    x_pos = -2.2 * pow(t, 1.4);
    s = 1.0 - 0.28 * pow(t - 0.45, 2) * 4;

    for (side = [-1, 1]) {
      translate([x_pos, y_pos])
        rotate([0, 0, side * (26 + t * 6) - 4 * t])
          translate([side * 2.5 * s, 0])
            scale([1.9 * s, 1.0 * s])
              circle(r = 1.7);
    }
  }

  translate([-2.2, length + 2.0])
    rotate([0, 0, -6])
      scale([0.95, 1.8])
        circle(r = 1.6);
}

// ---- PART 1 ----
// Parametric handle center point along smooth curve
function handle_curve_pt(t) =
  let(
    angle = 90 - t * 180,
    cx = -7.5,
    cy = 11.5,
    rx = 9.2,
    ry = 7.2
  )
  [ cx - rx * cos(angle), cy + ry * sin(angle) ];

// 2D footprints for base plate anchoring (flat bottom at y = 0)
module mug_outer_hull_2d() {
  polygon([
    [-8.2, 0],
    [8.2, 0],
    [8.5, 3.0],
    [10.0, 12.0],
    [9.5, 22.5],
    [-9.5, 22.5],
    [-10.0, 12.0],
    [-8.5, 3.0]
  ]);
}

module mug_handle_2d() {
  for (i = [0 : 15]) {
    t0 = i / 16;
    t1 = (i + 1) / 16;
    p0 = handle_curve_pt(t0);
    p1 = handle_curve_pt(t1);
    hull() {
      translate(p0) circle(r = 2.0);
      translate(p1) circle(r = 2.0);
    }
  }
}

module mug_foam_2d() {
  translate([0, 25.5]) circle(r = 5.2);
  translate([-4.2, 25.0]) circle(r = 4.4);
  translate([4.2, 24.8]) circle(r = 4.3);
  translate([-7.8, 23.2]) circle(r = 3.6);
  translate([7.8, 23.4]) circle(r = 3.7);
  translate([-2.2, 28.2]) circle(r = 3.2);
  translate([2.2, 27.8]) circle(r = 3.4);
  translate([-5.5, 27.0]) circle(r = 2.6);
  translate([5.6, 26.8]) circle(r = 2.7);
  hull() {
    translate([-3.2, 22.5]) circle(r = 2.8);
    translate([-3.6, 17.8]) circle(r = 2.0);
  }
  hull() {
    translate([4.8, 22.8]) circle(r = 2.6);
    translate([5.2, 18.8]) circle(r = 1.7);
  }
  translate([-9.2, 20.2]) circle(r = 2.0);
  translate([9.2, 20.5]) circle(r = 2.1);
  translate([-6.5, 30.0]) circle(r = 1.5);
  translate([6.2, 29.6]) circle(r = 1.6);
  translate([0, 31.0]) circle(r = 1.7);
}

// 3D Rounded Glass Mug Body with flat bottom, smooth barrel curvature and rounded D-handle
module single_mug_glass_3d(z_scale = 1.0) {
  scale([1, 1, z_scale]) {
    // Solid anchor sinking into base plate
    translate([0, 0, -0.2])
      linear_extrude(0.5) {
        mug_outer_hull_2d();
        mug_handle_2d();
      }

    // Glass body clipped flat at bottom (y >= 0)
    intersection() {
      union() {
        // Flat-bottom stepped foot ring (y = 0 to 3.2)
        for (step = [0 : 3]) {
          y0 = step * 0.8;
          y1 = (step + 1) * 0.8;
          w0 = 8.2 + step * 0.1;
          w1 = 8.2 + (step + 1) * 0.1;
          h0 = 1.8 + step * 0.1;
          h1 = 1.8 + (step + 1) * 0.1;

          hull() {
            translate([-w0 * 0.72, y0, 0]) dome(w0 * 0.42, h0 * 0.8);
            translate([0, y0, 0]) dome(w0 * 0.95, h0);
            translate([w0 * 0.72, y0, 0]) dome(w0 * 0.42, h0 * 0.8);

            translate([-w1 * 0.72, y1, 0]) dome(w1 * 0.42, h1 * 0.8);
            translate([0, y1, 0]) dome(w1 * 0.95, h1);
            translate([w1 * 0.72, y1, 0]) dome(w1 * 0.42, h1 * 0.8);
          }
        }

        // Smooth continuous 3D convex barrel body (y = 3.2 to 21.0)
        for (step = [0 : 11]) {
          y0 = 3.2 + step * (17.8 / 12);
          y1 = 3.2 + (step + 1) * (17.8 / 12);
          t0 = (y0 - 3.2) / 17.8;
          t1 = (y1 - 3.2) / 17.8;

          w0 = 8.5 + 1.6 * sin(t0 * 180);
          w1 = 8.5 + 1.6 * sin(t1 * 180);
          h0 = 1.9 + 0.9 * sin(t0 * 180);
          h1 = 1.9 + 0.9 * sin(t1 * 180);

          hull() {
            translate([-w0 * 0.72, y0, 0]) dome(w0 * 0.42, h0 * 0.8);
            translate([0, y0, 0]) dome(w0 * 0.95, h0);
            translate([w0 * 0.72, y0, 0]) dome(w0 * 0.42, h0 * 0.8);

            translate([-w1 * 0.72, y1, 0]) dome(w1 * 0.42, h1 * 0.8);
            translate([0, y1, 0]) dome(w1 * 0.95, h1);
            translate([w1 * 0.72, y1, 0]) dome(w1 * 0.42, h1 * 0.8);
          }
        }

        // Upper collar band
        hull() {
          translate([-8.8, 21.5, 0]) dome(2.2, 1.9);
          translate([0, 21.5, 0]) dome(3.0, 2.4);
          translate([8.8, 21.5, 0]) dome(2.2, 1.9);
          translate([-9.0, 22.8, 0]) dome(2.0, 1.7);
          translate([0, 22.8, 0]) dome(2.8, 2.2);
          translate([9.0, 22.8, 0]) dome(2.0, 1.7);
        }

        // Vertical Maßkrug fluted panel facets
        for (i = [-1.5, -0.5, 0.5, 1.5]) {
          x_b = i * 3.8;
          x_m = i * 4.6;
          x_t = i * 4.2;
          h_f = 2.6 - abs(i) * 0.25;
          hull() {
            translate([x_b, 4.2, 0.2]) dome(1.5, h_f);
            translate([x_m, 12.0, 0.3]) dome(1.8, h_f + 0.3);
            translate([x_t, 20.0, 0.2]) dome(1.6, h_f);
          }
        }
      }
      // Flat bottom boundary plane at y = 0
      translate([-30, 0, -5])
        cube([60, 50, 30]);
    }

    // 3D Rounded tubular ergonomic D-handle with rounded roots
    for (k = [0 : 15]) {
      t0 = k / 16;
      t1 = (k + 1) / 16;
      p0 = handle_curve_pt(t0);
      p1 = handle_curve_pt(t1);

      r_h0 = 1.9 + 0.5 * pow(sin(t0 * 180), 0.7);
      z_h0 = 1.8 + 0.6 * pow(sin(t0 * 180), 0.7);
      r_h1 = 1.9 + 0.5 * pow(sin(t1 * 180), 0.7);
      z_h1 = 1.8 + 0.6 * pow(sin(t1 * 180), 0.7);

      hull() {
        translate([p0[0], p0[1], 0]) dome(r_h0, z_h0);
        translate([p1[0], p1[1], 0]) dome(r_h1, z_h1);
      }
    }
  }
}

// 3D Bulbous Foam Head conforming over the rounded glass rim
module single_mug_foam_3d(z_scale = 1.0) {
  scale([1, 1, z_scale]) {
    translate([0, 0, -0.2])
      linear_extrude(0.5)
        mug_foam_2d();

    translate([0, 25.5, 0]) dome(5.2, 2.8);
    translate([-4.2, 25.0, 0]) dome(4.4, 2.6);
    translate([4.2, 24.8, 0]) dome(4.3, 2.6);
    translate([-7.8, 23.2, 0]) dome(3.6, 2.2);
    translate([7.8, 23.4, 0]) dome(3.7, 2.2);

    translate([-2.2, 28.2, 0]) dome(3.2, 2.4);
    translate([2.2, 27.8, 0]) dome(3.4, 2.4);
    translate([-5.5, 27.0, 0]) dome(2.6, 2.0);
    translate([5.6, 26.8, 0]) dome(2.7, 2.0);

    hull() {
      translate([-3.2, 22.5, 0.3]) dome(2.8, 2.5);
      translate([-3.6, 17.8, 0.3]) dome(2.0, 2.2);
    }
    hull() {
      translate([4.8, 22.8, 0.3]) dome(2.6, 2.5);
      translate([5.2, 18.8, 0.3]) dome(1.7, 2.2);
    }

    translate([-9.2, 20.2, 0.2]) dome(2.0, 2.0);
    translate([9.2, 20.5, 0.2]) dome(2.1, 2.0);

    translate([-6.5, 30.0, 0]) dome(1.5, 1.6);
    translate([6.2, 29.6, 0]) dome(1.6, 1.6);
    translate([0, 31.0, 0]) dome(1.7, 1.7);
  }
}

// Center splash and diamond flourishes between beer mugs (flat 2D relief)
module center_beer_flourish_2d(spacing = 40) {
  translate([0, 21.0]) {
    circle(r = 2.2);
    translate([0, 5.5]) circle(r = 1.6);
    translate([0, 9.2]) circle(r = 1.1);
    for (sx = [-1, 1]) {
      scale([sx, 1]) {
        translate([spacing * 0.18, 3.0]) circle(r = 1.6);
        translate([spacing * 0.32, 6.4]) circle(r = 1.3);
        translate([spacing * 0.22, 9.5]) circle(r = 1.0);
      }
    }
  }

  translate([0, 3.5]) {
    rotate([0, 0, 45])
      square([4.5, 4.5], center = true);
    for (sx = [-1, 1]) {
      scale([sx, 1]) {
        translate([spacing * 0.24, 0])
          rotate([0, 0, 45])
            square([3.2, 3.2], center = true);
        translate([spacing * 0.46, 0])
          rotate([0, 0, 45])
            square([2.2, 2.2], center = true);
      }
    }
  }
}

// Paired clinking beer steins foam (3D high relief)
module clinking_beer_steins_foam_3d(spacing = 40, z_scale = 1.0) {
  translate([-spacing, 0, 0])
    rotate([0, 0, -9])
      single_mug_foam_3d(z_scale);
  translate([spacing, 0, 0])
    mirror([1, 0, 0])
      rotate([0, 0, -9])
        single_mug_foam_3d(z_scale);
}

// Paired clinking beer steins gold (3D high relief glass mugs only)
module clinking_beer_steins_gold_3d(spacing = 40, z_scale = 1.0) {
  translate([-spacing, 0, 0])
    rotate([0, 0, -9])
      single_mug_glass_3d(z_scale);
  translate([spacing, 0, 0])
    mirror([1, 0, 0])
      rotate([0, 0, -9])
        single_mug_glass_3d(z_scale);
}

// Full Biergarten sign assembly
module biergarten_sign() {
  r_corner = 6;
  overlap = 0.05;
  beer_y_pos = -sign_height * 0.41;
  mug_z_scale = beer_relief_h / 2.8;

  difference() {
    union() {
      // 1. Base Plate
      color(color_base) {
        linear_extrude(base_thick) {
          sign_base_shape_2d(sign_width, sign_height, r_corner);
        }
      }

      // 2. Borders, Trim, Subtitle, Steins, and Wheat Stalks
      color(color_trim) {
        translate([0, 0, base_thick - overlap]) {
          linear_extrude(relief_h + overlap) {
            sign_borders_2d(sign_width, sign_height, r_corner);
            top_ornaments_2d(sign_height);

            // Subtitle text
            if (len(sub_text) > 0) {
              translate([0, -2.5]) {
                text(
                  text = sub_text,
                  size = text_size * 0.36,
                  font = "Liberation Sans:style=Bold",
                  halign = "center",
                  valign = "center",
                  spacing = 1.25
                );
              }
            }

            // Classic wheat stalk per side, rotated outwards
            for (sx = [-1, 1]) {
              scale([sx, 1]) {
                translate([69, -sign_height * 0.30])
                  rotate([0, 0, -18])
                    wheat_stalk_2d(length = 34, grains = 6);
              }
            }

            // Flat 2D center flourish between beer steins
            if (show_beers) {
              translate([0, beer_y_pos])
                center_beer_flourish_2d(beer_spacing);
            }
          }

          // 3D Rounded Gold Beer Steins (High 3D Relief)
          if (show_beers) {
            translate([0, beer_y_pos, overlap]) {
              clinking_beer_steins_gold_3d(beer_spacing, mug_z_scale);
            }
          }
        }
      }

      // 3. Main Lettering
      color(color_text) {
        translate([0, sign_height * 0.14, base_thick - overlap]) {
          linear_extrude(relief_h + overlap) {
            text(
              text = main_text,
              size = text_size,
              font = "Liberation Serif:style=Bold",
              halign = "center",
              valign = "center",
              spacing = 1.05
            );
          }
        }
      }

      // 4. White Beer Foam (3D bulbous heads and drips - High 3D Relief)
      if (show_beers) {
        color(color_foam) {
          translate([0, beer_y_pos, base_thick]) {
            clinking_beer_steins_foam_3d(beer_spacing, mug_z_scale);
          }
        }
      }
    }

    // Mounting Holes — coloured like the plate, so the bore walls are too
    if (mount_holes) {
      color(color_base) {
        for (sx = [-1, 1]) {
          translate([sx * sign_width * 0.41, sign_height * 0.18, -1]) {
            cylinder(h = base_thick + beer_relief_h + 10, d = hole_diam);
          }
        }
      }
    }
  }
}

biergarten_sign();
// ---- PART 1 END ----
