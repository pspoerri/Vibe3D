// A mounting plate. Drag the numbers, or edit freely.
$fn = 64;

plate_x = 60;  // [20:120]
plate_y = 40;  // [20:120]
plate_z = 3;   // [1:0.5:10]
hole_d  = 5;   // [2:0.5:12]
inset   = 6;   // [3:20]

difference() {
  cube([plate_x, plate_y, plate_z]);
  for (x = [inset, plate_x - inset], y = [inset, plate_y - inset])
    translate([x, y, -1])
      cylinder(h = plate_z + 2, d = hole_d);
}
