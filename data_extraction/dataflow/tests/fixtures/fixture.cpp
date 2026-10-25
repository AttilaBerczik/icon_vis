namespace demo {

struct State {
  double* field;
  int n;
};

inline double read_state(const State& s) {
  return s.field[0];
}

inline void write_state(State& s, double v) {
  s.field[0] = v;
}

inline void kernel(State s) {
  const auto body = KOKKOS_LAMBDA(int i) {
    s.field[i] = s.field[i] + 1.0;
  };
  (void)body;
}

}
