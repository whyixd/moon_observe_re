

  color COLOR1 = color(249,30,40,80);
  color COLOR2 = color(100,60,40);

int REPEAT_DRAW_NUM = 12;
float LED_STEP_ANGLE = PI/((LED_NUM-1)*2);

class transLight
{
  float X;
  float Y;
  float Z;
  float Angle;
  float SpinSpeed;
  float TargetSpeed;
  float SpinAngle;
  color[] LedColor_outter = new color[OUTTER_LED_NUM];
  //color[] LedColor_inner = new color[INNER_LED_NUM];
  float[] LedR = new float[LED_NUM];
  float[] LedH = new float[LED_NUM];
  //boolean IsTurnning = false;
  int turnningMode = 0;
  boolean isClockwise=true;
  boolean isForceStop=false;
  
  public transLight()
  {
    SpinSpeed=0;
    TargetSpeed=0;
    SpinAngle = 0;
    for(int i=0;i<LED_NUM;i++)
    {
      if(i<OUTTER_LED_NUM)
      {
        LedColor_outter[i]=color(200);
        LedR[i]=sin(i*LED_STEP_ANGLE)*LED_RADIUS+1;
        LedH[i]=cos(i*LED_STEP_ANGLE)*LED_RADIUS;
      }
      /*
      else
      {
        LedColor_inner[i-OUTTER_LED_NUM]=color(0);
        LedR[i]=sin(i*LED_STEP_ANGLE)*LED_RADIUS-1;
        LedH[i]=cos((OUTTER_LED_NUM*2-i)*LED_STEP_ANGLE)*LED_RADIUS;
      }
      */
    }
  }
  
  public void display()
  {
    
    calculateSpin();
    pushMatrix();
    translate(X, Y, Z);
    rotateZ(Angle);
    
    noStroke();
    //fill(0);
    //sphere(LED_RADIUS-2);
    

    rotateY(SpinAngle);
    
    noFill();
    
    
    beginShape(POINTS);
    for(int i=0;i<LED_NUM;i++)
    {
      float direction=0;
      for(int j=0;j<ARM_NUM;j++)
      {
        direction = (TWO_PI/ARM_NUM)*j;
        strokeWeight(LED_SIZE);
        stroke(LedColor_outter[LED_NUM-1-i]);

        vertex( ((j+1)%2)*(cos(PI+direction)*  LedR[i] ),
                LedH[i] ,
                (j%2)*    (-sin(PI+direction)* LedR[i] ));
              
        strokeWeight(LED_SIZE+2.8);
        stroke(0);
        vertex( ((j+1)%2)*(cos(PI+direction)*  (LedR[i]-3) ),
                LedH[i] ,
                (j%2)*    (-sin(PI+direction)* (LedR[i]-3) ));
                
      }
    }
    endShape();
    
    popMatrix();
  }
  
  void calculateSpin()
  {
    if(turnningMode==2)
      SpinAngle+=SPIN_SPEED;
    else if(turnningMode==1)
      SpinAngle+=SPIN_SPEED;
    /*
    float targetMappedSpeed = map(int(SpinSpeed),0,255,0,SPIN_SPEED);
    if(targetMappedSpeed>MappedSpinSpeed[i])MappedSpinSpeed[i]+=spinAcc;
    else if(targetMappedSpeed<MappedSpinSpeed[i])MappedSpinSpeed[i]-=spinAcc;
    
    if(MappedSpinSpeed[i]<0)MappedSpinSpeed[i]=0;
    else if(MappedSpinSpeed[i]>spinSpeed)MappedSpinSpeed[i]=spinSpeed;
    
    SpinAngle[i]+=MappedSpinSpeed[i];
    */
    
  }
}
