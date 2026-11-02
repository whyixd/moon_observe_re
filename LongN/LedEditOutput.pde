final int OUTPUT_START_X=70;
final int OUTPUT_START_Y=0;
final int COLUM_W=3;

void drawOutput()
{
  
  loadPixels();
  int currentDrawingX=0;
  int currentDrawingY=0;
  int currentDrawingY_OP=0;
  
  for(int r=0;r<MOTOR_NUM;r++)
  {
    for(int i=0;i<OUTTER_LED_NUM;i++)
    {
      currentDrawingX=OUTPUT_START_X+r*3;
      currentDrawingY=OUTTER_LED_NUM-1-i;
      currentDrawingY_OP=OUTTER_LED_NUM+i;
      
      
      pixels[currentDrawingX+currentDrawingY*width] = transLights[r].LedColor_outter[i];
      pixels[currentDrawingX+1+currentDrawingY*width] = transLights[r].LedColor_outter[i];
      pixels[currentDrawingX+2+currentDrawingY*width] = transLights[r].LedColor_outter[i];
      
      pixels[currentDrawingX+currentDrawingY_OP*width] = transLights[r].LedColor_outter[i];
      pixels[currentDrawingX+1+currentDrawingY_OP*width] = transLights[r].LedColor_outter[i];
      pixels[currentDrawingX+2+currentDrawingY_OP*width] = transLights[r].LedColor_outter[i];
    }
    
  }
  
  updatePixels();
}
