package sample

func run() string {
  return "ok"
}

type User struct {
  Name string
}

type Notifier interface {
  Notify(msg string)
}

func (u *User) DoWork() {
}
