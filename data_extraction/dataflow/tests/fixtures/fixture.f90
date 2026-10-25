MODULE fixture_mod
  USE mo_kind, ONLY: wp
  IMPLICIT NONE

  TYPE :: t_state
    REAL(wp), ALLOCATABLE :: field(:)
    REAL(wp), ALLOCATABLE :: other(:)
  END TYPE t_state

  TYPE(t_state) :: global_state

CONTAINS

  SUBROUTINE writer(state, n)
    TYPE(t_state), INTENT(INOUT) :: state
    INTEGER, INTENT(IN) :: n
    !$ACC PARALLEL LOOP PRESENT(state%field)
    state % field(:) = REAL(n, wp)
  END SUBROUTINE writer

  SUBROUTINE reader(state, value)
    TYPE(t_state), INTENT(IN) :: state
    REAL(wp), INTENT(OUT) :: value
    value = SUM(state % field)
  END SUBROUTINE reader

  SUBROUTINE caller(state)
    TYPE(t_state), INTENT(INOUT) :: state
    REAL(wp) :: value
    CALL writer(state, 1)
    CALL reader(state, value)
  END SUBROUTINE caller

END MODULE fixture_mod
