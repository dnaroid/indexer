using System;
using UnityEngine;

public class Player : MonoBehaviour {
  public int Health;
  [SerializeField] private float speed;
  public static int Global;
  [NonSerialized] public int DebugValue;
  [HideInInspector] public int Hidden;

  public int Score { get; set; }

  public void Fire() {
  }

  void Update() {
  }
}

public struct Point {
  public int X;
}

public interface IRunnable {
  void Run();
}

public enum State {
  Idle,
  Active
}

[CreateAssetMenu]
public class Settings : ScriptableObject {
}
