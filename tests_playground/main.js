
    class UserManager {
      constructor() { this.users = [] }
      addUser(u) { this.users.push(u) }
    }
    
    function init() {
      const um = new UserManager()
      um.addUser('alice')
    }
  