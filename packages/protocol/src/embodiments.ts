/**
 * The embodiment registry.
 *
 * Every entry is a MuJoCo Menagerie model under a permissive licence — MIT,
 * Apache-2.0, BSD-2-Clause or BSD-3-Clause — so all of these are commercially
 * usable. `licence` is recorded per model because that is the question a
 * buyer's counsel asks, and "the repo is Apache" is not the answer: the licence
 * sits per model directory.
 *
 * `trademarkCheck` marks models whose branded hardware deserves a lawyer's ten
 * minutes before shipping commercially, regardless of the code licence.
 */
export type Class = "humanoid" | "biped" | "quadruped" | "arm" | "bimanual"
  | "hand" | "gripper" | "mobile_manipulator" | "drone" | "base";

export type Embodiment = {
  id: string;
  name: string;
  vendor: string;
  class: Class;
  /** Actuated degrees of freedom, excluding the free base. */
  dof: number;
  licence: string;
  menagerie: string;
  /** Action spaces a curator may publish against this model. */
  actionSpaces: string[];
  trademarkCheck?: boolean;
  note?: string;
  /**
   * Per-joint `[min, max]` limits in radians, ordered to match the model's
   * actuated-joint order in its Menagerie MJCF. Used by T-018's
   * `kinematics.v1` check (PLAN §10.9 id 0x0003). Absent for embodiments
   * without recorded limits — the check emits `inconclusive` for those.
   */
  jointLimits?: [number, number][];
  /** Per-joint velocity cap in rad/s, same order as `jointLimits`. */
  maxVel?: number[];
};

const EE = ["ee_pose_gripper"];
const EE_JOINT = ["ee_pose_gripper", "joint_position"];
const HUMANOID = ["ee_pose_gripper", "whole_body_retarget"];
const LOCO = ["base_velocity"];

export const EMBODIMENTS: Embodiment[] = [
  // ---------------------------------------------------------------- humanoids
  { id: "unitree_g1", name: "G1", vendor: "Unitree", class: "humanoid", dof: 43, licence: "BSD-3-Clause", menagerie: "unitree_g1", actionSpaces: HUMANOID, note: "The volume humanoid: cheapest real hardware, widest community, most existing teleop data. Start here." },
  { id: "unitree_h1", name: "H1", vendor: "Unitree", class: "humanoid", dof: 19, licence: "BSD-3-Clause", menagerie: "unitree_h1", actionSpaces: HUMANOID, note: "Full-size, high-power. Locomotion and loco-manipulation." },
  { id: "apptronik_apollo", name: "Apollo", vendor: "Apptronik", class: "humanoid", dof: 30, licence: "Apache-2.0", menagerie: "apptronik_apollo", actionSpaces: HUMANOID, note: "Commercial warehouse humanoid. Credible for logistics tasks." },
  { id: "booster_t1", name: "T1", vendor: "Booster Robotics", class: "humanoid", dof: 23, licence: "Apache-2.0", menagerie: "booster_t1", actionSpaces: HUMANOID },
  { id: "fourier_n1", name: "N1", vendor: "Fourier", class: "humanoid", dof: 23, licence: "Apache-2.0", menagerie: "fourier_n1", actionSpaces: HUMANOID },
  { id: "pal_talos", name: "TALOS", vendor: "PAL Robotics", class: "humanoid", dof: 32, licence: "Apache-2.0", menagerie: "pal_talos", actionSpaces: HUMANOID, note: "European research standard, torque-controlled." },
  { id: "berkeley_humanoid", name: "Berkeley Humanoid", vendor: "UC Berkeley", class: "humanoid", dof: 12, licence: "BSD-3-Clause", menagerie: "berkeley_humanoid", actionSpaces: LOCO },
  { id: "robotis_op3", name: "OP3", vendor: "Robotis", class: "humanoid", dof: 20, licence: "Apache-2.0", menagerie: "robotis_op3", actionSpaces: HUMANOID },
  { id: "pnd_adam_lite", name: "Adam Lite", vendor: "PNDbotics", class: "humanoid", dof: 25, licence: "MIT", menagerie: "pndbotics_adam_lite", actionSpaces: HUMANOID },
  { id: "toddlerbot_2xc", name: "ToddlerBot 2XC", vendor: "Stanford", class: "humanoid", dof: 30, licence: "MIT", menagerie: "toddlerbot_2xc", actionSpaces: HUMANOID },
  { id: "toddlerbot_2xm", name: "ToddlerBot 2XM", vendor: "Stanford", class: "humanoid", dof: 30, licence: "MIT", menagerie: "toddlerbot_2xm", actionSpaces: HUMANOID },
  { id: "agility_cassie", name: "Cassie", vendor: "Agility Robotics", class: "biped", dof: 10, licence: "MIT", menagerie: "agility_cassie", actionSpaces: LOCO, note: "Legs only. Locomotion benchmark, not manipulation." },

  // --------------------------------------------------------------- quadrupeds
  { id: "unitree_go2", name: "Go2", vendor: "Unitree", class: "quadruped", dof: 12, licence: "BSD-3-Clause", menagerie: "unitree_go2", actionSpaces: LOCO, note: "The volume quadruped." },
  { id: "unitree_go1", name: "Go1", vendor: "Unitree", class: "quadruped", dof: 12, licence: "BSD-3-Clause", menagerie: "unitree_go1", actionSpaces: LOCO },
  { id: "unitree_a1", name: "A1", vendor: "Unitree", class: "quadruped", dof: 12, licence: "BSD-3-Clause", menagerie: "unitree_a1", actionSpaces: LOCO },
  { id: "anymal_b", name: "ANYmal B", vendor: "ANYbotics", class: "quadruped", dof: 12, licence: "BSD-3-Clause", menagerie: "anybotics_anymal_b", actionSpaces: LOCO },
  { id: "anymal_c", name: "ANYmal C", vendor: "ANYbotics", class: "quadruped", dof: 12, licence: "BSD-3-Clause", menagerie: "anybotics_anymal_c", actionSpaces: LOCO, note: "Industrial inspection, real commercial deployments." },
  { id: "bd_spot", name: "Spot", vendor: "Boston Dynamics", class: "quadruped", dof: 12, licence: "BSD-3-Clause", menagerie: "boston_dynamics_spot", actionSpaces: LOCO, trademarkCheck: true, note: "Highest brand recognition. Check trademark before commercial use." },
  { id: "barkour_v0", name: "Barkour v0", vendor: "Google", class: "quadruped", dof: 12, licence: "Apache-2.0", menagerie: "google_barkour_v0", actionSpaces: LOCO },
  { id: "barkour_vb", name: "Barkour vB", vendor: "Google", class: "quadruped", dof: 12, licence: "Apache-2.0", menagerie: "google_barkour_vb", actionSpaces: LOCO },

  // --------------------------------------------------------------------- arms
  {
    id: "franka_panda", name: "Panda", vendor: "Franka Emika", class: "arm", dof: 7, licence: "Apache-2.0", menagerie: "franka_emika_panda", actionSpaces: EE_JOINT, note: "The research standard. Most published datasets use it.",
    // Ranges from menagerie's franka_emika_panda/panda.xml <joint range="…">
    // (joint1..joint7); velocity caps from Franka's published joint
    // velocity limits (dq_max), same order. Approximated from the
    // manufacturer spec sheet, not re-fetched from the MJCF for this task
    // (see TASK-018.md note) — reasonable but not re-verified against the
    // file bytes.
    jointLimits: [[-2.8973, 2.8973], [-1.7628, 1.7628], [-2.8973, 2.8973], [-3.0718, -0.0698], [-2.8973, 2.8973], [-0.0175, 3.7525], [-2.8973, 2.8973]],
    maxVel: [2.175, 2.175, 2.175, 2.175, 2.61, 2.61, 2.61],
  },
  { id: "franka_fr3", name: "FR3", vendor: "Franka Robotics", class: "arm", dof: 7, licence: "Apache-2.0", menagerie: "franka_fr3", actionSpaces: EE_JOINT },
  {
    id: "ur5e", name: "UR5e", vendor: "Universal Robots", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "universal_robots_ur5e", actionSpaces: EE_JOINT, trademarkCheck: true, note: "The industrial standard, highest real install base.",
    // menagerie's universal_robots_ur5e/ur5e.xml gives each joint the
    // default UR unlimited-rotation range (+-2*pi); velocity caps from UR's
    // published max joint speed (~180 deg/s), approximated uniformly across
    // joints rather than re-read from the MJCF (see TASK-018.md note).
    jointLimits: [[-6.2832, 6.2832], [-6.2832, 6.2832], [-6.2832, 6.2832], [-6.2832, 6.2832], [-6.2832, 6.2832], [-6.2832, 6.2832]],
    maxVel: [3.15, 3.15, 3.15, 3.2, 3.2, 3.2],
  },
  { id: "ur10e", name: "UR10e", vendor: "Universal Robots", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "universal_robots_ur10e", actionSpaces: EE_JOINT, trademarkCheck: true },
  { id: "kuka_iiwa14", name: "LBR iiwa 14", vendor: "KUKA", class: "arm", dof: 7, licence: "BSD-3-Clause", menagerie: "kuka_iiwa_14", actionSpaces: EE_JOINT, trademarkCheck: true },
  { id: "kinova_gen3", name: "Gen3", vendor: "Kinova", class: "arm", dof: 7, licence: "BSD-3-Clause", menagerie: "kinova_gen3", actionSpaces: EE_JOINT },
  { id: "flexiv_rizon4", name: "Rizon 4", vendor: "Flexiv", class: "arm", dof: 7, licence: "Apache-2.0", menagerie: "flexiv_rizon4", actionSpaces: EE_JOINT, note: "Force-controlled — directly relevant to contact data." },
  { id: "flexiv_rizon4s", name: "Rizon 4S", vendor: "Flexiv", class: "arm", dof: 7, licence: "Apache-2.0", menagerie: "flexiv_rizon4s", actionSpaces: EE_JOINT },
  { id: "xarm7", name: "xArm7", vendor: "UFACTORY", class: "arm", dof: 7, licence: "BSD-3-Clause", menagerie: "ufactory_xarm7", actionSpaces: EE_JOINT },
  { id: "lite6", name: "Lite 6", vendor: "UFACTORY", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "ufactory_lite6", actionSpaces: EE_JOINT },
  {
    id: "viperx300", name: "ViperX 300 6DOF", vendor: "Trossen", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "trossen_vx300s", actionSpaces: EE_JOINT,
    // Approximate ranges for menagerie's trossen_vx300s/vx300s.xml joints
    // (waist, shoulder, elbow, forearm_roll, wrist_angle, wrist_rotate),
    // derived from Trossen's published Dynamixel-servo travel limits rather
    // than re-read from the MJCF file bytes (see TASK-018.md note). Velocity
    // cap approximated from Dynamixel XM430/XM540 typical max speed.
    jointLimits: [[-3.1416, 3.1416], [-1.8850, 1.9897], [-1.7907, 1.6231], [-3.1416, 3.1416], [-1.7453, 2.1468], [-3.1416, 3.1416]],
    maxVel: [3.0, 3.0, 3.0, 3.0, 3.0, 3.0],
  },
  {
    id: "widowx250", name: "WidowX 250 6DOF", vendor: "Trossen", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "trossen_wx250s", actionSpaces: EE_JOINT,
    // Approximate ranges for menagerie's trossen_wx250s/wx250s.xml joints
    // (waist, shoulder, elbow, forearm_roll, wrist_angle, wrist_rotate),
    // derived from Trossen's published Dynamixel-servo travel limits rather
    // than re-read from the MJCF file bytes (see TASK-018.md note). Velocity
    // cap approximated from Dynamixel XM430 typical max speed.
    jointLimits: [[-3.1416, 3.1416], [-1.8850, 1.9897], [-1.7907, 1.6231], [-3.1416, 3.1416], [-1.7453, 2.1468], [-3.1416, 3.1416]],
    maxVel: [3.0, 3.0, 3.0, 3.0, 3.0, 3.0],
  },
  { id: "unitree_z1", name: "Z1", vendor: "Unitree", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "unitree_z1", actionSpaces: EE_JOINT },
  { id: "arx_l5", name: "L5", vendor: "ARX", class: "arm", dof: 6, licence: "BSD-3-Clause", menagerie: "arx_l5", actionSpaces: EE_JOINT },
  { id: "agilex_piper", name: "PiPER", vendor: "AgileX", class: "arm", dof: 6, licence: "MIT", menagerie: "agilex_piper", actionSpaces: EE_JOINT },
  { id: "rethink_sawyer", name: "Sawyer", vendor: "Rethink Robotics", class: "arm", dof: 7, licence: "Apache-2.0", menagerie: "rethink_robotics_sawyer", actionSpaces: EE_JOINT },
  {
    id: "so_arm100", name: "SO-ARM100", vendor: "TheRobotStudio", class: "arm", dof: 5, licence: "Apache-2.0", menagerie: "trs_so_arm100", actionSpaces: EE_JOINT, note: "Sub-$500. The LeRobot community default.",
    // Approximate ranges for menagerie's trs_so_arm100/so_arm100.xml joints
    // (rotation, pitch, elbow, wrist_pitch, wrist_roll), derived from the
    // STS3215 servo's ~270 deg mechanical travel rather than re-read from
    // the MJCF file bytes (see TASK-018.md note). Velocity cap approximated
    // from the STS3215's rated no-load speed.
    jointLimits: [[-2.0, 2.0], [-1.75, 1.75], [-1.6, 1.6], [-1.75, 1.75], [-2.7, 2.7]],
    maxVel: [4.8, 4.8, 4.8, 4.8, 4.8],
  },
  { id: "low_cost_arm", name: "Low-Cost Robot Arm", vendor: "Community", class: "arm", dof: 5, licence: "Apache-2.0", menagerie: "low_cost_robot_arm", actionSpaces: EE_JOINT },
  { id: "yam", name: "YAM", vendor: "I2RT", class: "arm", dof: 6, licence: "MIT", menagerie: "i2rt_yam", actionSpaces: EE_JOINT },
  { id: "seeed_devarm", name: "reBot DevArm", vendor: "Seeed Studio", class: "arm", dof: 6, licence: "MIT", menagerie: "seeed_studio_devarm", actionSpaces: EE_JOINT },

  // ----------------------------------------------------------------- bimanual
  { id: "aloha", name: "ALOHA", vendor: "Stanford / Trossen", class: "bimanual", dof: 14, licence: "BSD-3-Clause", menagerie: "aloha", actionSpaces: EE, note: "The reference bimanual platform; most imitation-learning work targets it." },

  // ------------------------------------------------------- hands and grippers
  { id: "shadow_hand", name: "Hand E3M5", vendor: "Shadow Robot", class: "hand", dof: 24, licence: "Apache-2.0", menagerie: "shadow_hand", actionSpaces: EE, note: "The dexterity benchmark." },
  { id: "shadow_dex_ee", name: "DEX-EE", vendor: "Shadow Robot", class: "hand", dof: 12, licence: "Apache-2.0", menagerie: "shadow_dexee", actionSpaces: EE },
  { id: "allegro_hand", name: "Allegro Hand V3", vendor: "Wonik", class: "hand", dof: 16, licence: "BSD-2-Clause", menagerie: "wonik_allegro", actionSpaces: EE, note: "The most common research hand." },
  { id: "leap_hand", name: "Leap Hand", vendor: "CMU", class: "hand", dof: 16, licence: "MIT", menagerie: "leap_hand", actionSpaces: EE },
  { id: "robotiq_2f85", name: "2F-85", vendor: "Robotiq", class: "gripper", dof: 1, licence: "BSD-2-Clause", menagerie: "robotiq_2f85", actionSpaces: EE, note: "The industrial gripper." },
  { id: "panda_gripper", name: "Panda Gripper", vendor: "Franka Emika", class: "gripper", dof: 1, licence: "Apache-2.0", menagerie: "franka_emika_panda", actionSpaces: EE },
  { id: "umi_gripper", name: "UMI Gripper", vendor: "Stanford", class: "gripper", dof: 1, licence: "MIT", menagerie: "umi_gripper", actionSpaces: EE, note: "Handheld capture without a robot — the closest existing thing to the Band." },
  { id: "sharpa_wave", name: "Sharpa Wave", vendor: "Sharpa", class: "hand", dof: 16, licence: "Apache-2.0", menagerie: "sharpa_wave", actionSpaces: EE, note: "Tactile-focused." },
  { id: "xarm7_gripper", name: "xArm Gripper", vendor: "UFACTORY", class: "gripper", dof: 1, licence: "BSD-3-Clause", menagerie: "ufactory_xarm7", actionSpaces: EE },

  // -------------------------------------------------- mobile manipulators etc
  { id: "stretch3", name: "Stretch 3", vendor: "Hello Robot", class: "mobile_manipulator", dof: 7, licence: "Apache-2.0", menagerie: "hello_robot_stretch_3", actionSpaces: EE, note: "Real household deployments." },
  { id: "stretch2", name: "Stretch 2", vendor: "Hello Robot", class: "mobile_manipulator", dof: 7, licence: "BSD-3-Clause-Clear", menagerie: "hello_robot_stretch", actionSpaces: EE },
  { id: "pal_tiago", name: "TIAGo", vendor: "PAL Robotics", class: "mobile_manipulator", dof: 8, licence: "Apache-2.0", menagerie: "pal_tiago", actionSpaces: EE },
  { id: "pal_tiago_dual", name: "TIAGo++", vendor: "PAL Robotics", class: "mobile_manipulator", dof: 15, licence: "Apache-2.0", menagerie: "pal_tiago_dual", actionSpaces: EE },
  { id: "google_robot", name: "Google Robot", vendor: "Google", class: "mobile_manipulator", dof: 7, licence: "Apache-2.0", menagerie: "google_robot", actionSpaces: EE },
  { id: "tidybot", name: "TidyBot", vendor: "Stanford", class: "mobile_manipulator", dof: 7, licence: "MIT", menagerie: "stanford_tidybot", actionSpaces: EE },
  { id: "skydio_x2", name: "X2", vendor: "Skydio", class: "drone", dof: 4, licence: "Apache-2.0", menagerie: "skydio_x2", actionSpaces: LOCO },
  { id: "crazyflie2", name: "Crazyflie 2", vendor: "Bitcraze", class: "drone", dof: 4, licence: "MIT", menagerie: "bitcraze_crazyflie_2", actionSpaces: LOCO },
];

export const byId = (id: string) => EMBODIMENTS.find((e) => e.id === id);
export const byClass = (c: Class) => EMBODIMENTS.filter((e) => e.class === c);
export const needsTrademarkCheck = () => EMBODIMENTS.filter((e) => e.trademarkCheck);
