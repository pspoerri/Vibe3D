// Ferrari Vintage Tractor

// Overall model length
tractor_length = 95;    // [70:1:140]
// Rear tire outer diameter
rear_wheel_d = 42;      // [30:1:60]
// Front tire outer diameter
front_wheel_d = 26;     // [18:1:40]
// Rear track width (outer tire to outer tire)
track_width = 56;       // [40:1:80]
// Exhaust stack height above hood
exhaust_height = 26;    // [15:1:45]

$fn = 48;

wheelbase = tractor_length * 0.55;
rear_radius = rear_wheel_d / 2;
front_radius = front_wheel_d / 2;
bed_trim = 0.8;

rear_axle_z = rear_radius - bed_trim;
front_axle_z = front_radius - bed_trim;
rear_axle_x = -wheelbase * 0.42;
front_axle_x = rear_axle_x + wheelbase;

rear_wheel_w = 13;
front_wheel_w = 8;
hood_width = 22;
hood_length = 44;
chassis_width = 18;

module hood_and_engine() {
  hood_z = front_axle_z + 3;
  
  // Streamlined rounded hood
  translate([front_axle_x - hood_length + 6, -hood_width/2, hood_z]) {
    hull() {
      // Rear dash
      cube([1, hood_width, 19]);
      translate([0, hood_width/2, 19])
        rotate([0, 90, 0])
          cylinder(r = hood_width/2, h = 1);
      // Front nose transition
      translate([hood_length - 4, 1.5, 0])
        cube([1, hood_width - 3, 16]);
      translate([hood_length - 4, hood_width/2, 16])
        rotate([0, 90, 0])
          cylinder(r = hood_width/2 - 1.5, h = 1);
    }
  }

  // Rounded front nose cone & grille
  nose_x = front_axle_x + 9;
  hull() {
    translate([nose_x - 3, 0, front_axle_z + 11])
      rotate([0, 90, 0])
        scale([1.15, 0.88, 1])
          cylinder(r = 9.5, h = 4, center = true);
    translate([nose_x - 5, -hood_width/2 + 2, front_axle_z + 3])
      cube([4, hood_width - 4, 12]);
  }

  // Grille horizontal slat details
  for (z_off = [-5:2.2:5]) {
    translate([nose_x - 0.5, 0, front_axle_z + 11 + z_off])
      cube([2, hood_width - 9, 1.2], center = true);
  }

  // Side headlights
  for (s = [-1, 1]) {
    translate([front_axle_x + 6, s * (hood_width/2 - 1), front_axle_z + 14]) {
      rotate([0, 15, 0]) {
        sphere(r = 3.2);
        rotate([0, 90, 0]) cylinder(r = 2.4, h = 2.5);
      }
    }
  }

  // Vertical exhaust stack
  exhaust_x = front_axle_x - 8;
  exhaust_y = -hood_width/2 + 3.5;
  exhaust_base_z = front_axle_z + 17;
  translate([exhaust_x, exhaust_y, exhaust_base_z]) {
    cylinder(r = 2.4, h = exhaust_height);
    // Muffler section
    translate([0, 0, 5])
      cylinder(r = 3.8, h = 12);
    // Rain cap
    translate([0, 0, exhaust_height])
      rotate([0, 25, 0])
        cylinder(r = 3.2, h = 1.4);
  }

  // Air cleaner on opposite side
  translate([exhaust_x - 5, hood_width/2 - 3.5, exhaust_base_z - 2]) {
    cylinder(r = 2, h = 13);
    translate([0, 0, 13])
      cylinder(r1 = 2.5, r2 = 4, h = 6);
  }
}

module operator_station() {
  // Steering column and wheel
  translate([rear_axle_x + 13, 0, rear_axle_z + 6]) {
    rotate([0, -32, 0]) {
      cylinder(r = 2.2, h = 19);
      translate([0, 0, 18]) {
        difference() {
          cylinder(r = 8.5, h = 2.5);
          translate([0, 0, -0.5]) cylinder(r = 6.5, h = 3.5);
        }
        cylinder(r = 2.5, h = 2.5);
        for (a = [0, 120, 240]) {
          rotate([0, 0, a])
            translate([-1, -0.7, 0])
              cube([8, 1.4, 2]);
        }
      }
    }
  }

  // Pan seat and spring mount
  seat_x = rear_axle_x + 1;
  seat_z = rear_axle_z + 11;
  translate([seat_x - 8, -3, rear_axle_z + 2]) {
    hull() {
      cube([5, 6, 3]);
      translate([5, 0, 7]) cube([4, 6, 3]);
    }
  }
  translate([seat_x - 1, 0, seat_z]) {
    difference() {
      hull() {
        cylinder(r = 8, h = 3.5, center = true);
        translate([-3, 0, 2.5]) cube([7, 13, 3.5], center = true);
      }
      translate([0, 0, 1.2])
        cylinder(r = 7, h = 4);
    }
  }
}

module single_rear_fender() {
  fender_r_inner = rear_radius + 1.5;
  fender_thick = 2.5;
  fender_w = rear_wheel_w + 3;
  y_wheel = track_width/2 - rear_wheel_w/2;
  y_inner = y_wheel - fender_w/2;

  // 1. Curved top arch over tire
  translate([rear_axle_x, y_wheel, rear_axle_z]) {
    rotate([90, 0, 0]) {
      difference() {
        cylinder(r = fender_r_inner + fender_thick, h = fender_w, center = true);
        cylinder(r = fender_r_inner, h = fender_w + 4, center = true);
        // Cut out bottom and front lower quadrants
        translate([-fender_r_inner * 2.5, -fender_r_inner * 2.5, -fender_w])
          cube([fender_r_inner * 5, fender_r_inner * 2.5, fender_w * 2]);
        translate([0, 0, -fender_w])
          cube([fender_r_inner * 2.5, fender_r_inner * 2.5, fender_w * 2]);
      }
    }
  }

  // 2. Solid inner valance / side wall bridging arch down to chassis & floor
  translate([rear_axle_x, y_inner, rear_axle_z]) {
    hull() {
      // Top curve attachment
      translate([-fender_r_inner * 0.7, 0, fender_r_inner * 0.7])
        cube([fender_r_inner * 1.4, 2.5, 2]);
      // Bottom floor attachment
      translate([-14, -(y_inner - chassis_width/2 + 2), -4])
        cube([26, y_inner - chassis_width/2 + 4, 6]);
      // Central axle hub connection
      translate([0, -2, 0])
        rotate([-90, 0, 0])
          cylinder(r = 6, h = 4);
    }
  }

  // 3. Sturdy heavy lower structural mount
  translate([rear_axle_x - 12, chassis_width/2 - 2, rear_axle_z - 3])
    cube([22, y_inner - chassis_width/2 + 4, 6]);
}

module fenders_and_chassis() {
  // Main chassis belly
  hull() {
    translate([rear_axle_x - 12, -chassis_width/2, rear_axle_z - 4])
      cube([wheelbase + 16, chassis_width, 10]);
    translate([rear_axle_x - 6, -chassis_width/2 + 2, rear_axle_z + 4])
      cube([wheelbase + 6, chassis_width - 4, 10]);
    translate([front_axle_x - 8, -chassis_width/2, front_axle_z - 3])
      cube([14, chassis_width, 8]);
  }

  // Continuous foot platform bridging both sides
  fender_w = rear_wheel_w + 3;
  footrest_w = track_width - fender_w + 2;
  translate([rear_axle_x - 8, -footrest_w/2, rear_axle_z - 2])
    cube([28, footrest_w, 4.5]);

  // Both symmetrical rear fenders
  single_rear_fender();
  mirror([0, 1, 0]) single_rear_fender();

  // Heavy continuous structural axle trumpets
  translate([front_axle_x, -track_width/2, front_axle_z])
    rotate([-90, 0, 0])
      cylinder(r = 3.5, h = track_width);

  translate([rear_axle_x, -track_width/2, rear_axle_z])
    rotate([-90, 0, 0])
      cylinder(r = 5, h = track_width);

  // Rear drawbar / hitch
  translate([rear_axle_x - 17, -7, rear_axle_z - 3]) {
    difference() {
      cube([10, 14, 4.5]);
      translate([3.5, 7, -1]) cylinder(r = 2.5, h = 7);
    }
  }
}

module wheel_solid(dia, width, lug_count, is_rear = true) {
  r = dia / 2;
  rotate([90, 0, 0]) {
    union() {
      // Tire main body
      cylinder(r = r - 0.5, h = width, center = true);
      scale([1, 1, width / (2 * r)])
        sphere(r = r);

      // Wheel hub
      cylinder(r = r * 0.65, h = width + 0.6, center = true);
      translate([0, 0, width/2])
        cylinder(r = r * 0.3, h = 1.5);

      // Deeply merged Agricultural Lugs
      if (is_rear) {
        for (i = [0 : lug_count - 1]) {
          rotate([0, 0, i * (360 / lug_count)]) {
            // Left chevron wing
            translate([r - 2.5, -1, -width/4])
              rotate([0, 24, -28])
                cube([4.5, 3.2, width * 0.55], center = true);
            // Right chevron wing
            translate([r - 2.5, 1, width/4])
              rotate([0, -24, 28])
                cube([4.5, 3.2, width * 0.55], center = true);
          }
        }
      } else {
        // Front circumferential rib treads
        for (a = [0:18:342]) {
          rotate([0, 0, a])
            translate([r - 1.5, 0, 0])
              cube([3.5, 1.8, width - 1], center = true);
        }
      }
    }
  }
}

// ---- PART 1 ----
module ferrari_tractor() {
  difference() {
    union() {
      hood_and_engine();
      operator_station();
      fenders_and_chassis();

      // Rear wheels
      translate([rear_axle_x, track_width/2 - rear_wheel_w/2, rear_axle_z])
        wheel_solid(rear_wheel_d, rear_wheel_w, 14, true);
      translate([rear_axle_x, -track_width/2 + rear_wheel_w/2, rear_axle_z])
        wheel_solid(rear_wheel_d, rear_wheel_w, 14, true);

      // Front wheels
      front_y = track_width/2 - rear_wheel_w + front_wheel_w/2 - 2;
      translate([front_axle_x, front_y, front_axle_z])
        wheel_solid(front_wheel_d, front_wheel_w, 12, false);
      translate([front_axle_x, -front_y, front_axle_z])
        wheel_solid(front_wheel_d, front_wheel_w, 12, false);
    }
    // Trim base to ensure perfectly flat print bed contact at Z=0
    translate([-tractor_length, -track_width * 2, -30])
      cube([tractor_length * 3, track_width * 4, 30]);
  }
}

ferrari_tractor();
