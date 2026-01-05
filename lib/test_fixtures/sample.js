function foo() {
  return 'ok'
}

export default function main() {
  return 'default'
}

class Widget {
  id = 1
  #secret = 2

  get status() {
    return 'ok'
  }

  set status(value) {
    void value
  }

  render() {
    return 'rendered'
  }
}

export {foo, Widget}
