pub fn do_stuff() -> &'static str {
  "ok"
}

pub struct Widget {
  pub id: i32
}

impl Widget {
  pub fn render(&self) -> i32 {
    self.id
  }
}
