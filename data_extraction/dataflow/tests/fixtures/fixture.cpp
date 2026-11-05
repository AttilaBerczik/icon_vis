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

struct Box {
  double value;
  int n;
  Box(int n_);
  void init(int n_);
};

inline Box::Box(int n_) : value(0.0), n(n_) {}

inline void Box::init(int n_) {
  this->value = 0.0;
  this->n = n_;
}

inline void make_box(int n) {
  Box b(n);
  b.init(n);
}

struct Multi {
  int a, b;
  double *c, d[3];
  void (*cb)(int);
};

struct View {
  double* data;
  double operator()(int i) const { return data[i]; }
};

inline double read_view(View v, int i) {
  return v(i);
}

}
